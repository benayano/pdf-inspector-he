//! The totals box and the arithmetic checks over the whole invoice.
use once_cell::sync::Lazy;
use regex::Regex;

use super::amount::parse_amount;
use super::js::round2;
use super::model::{Check, FailedRow, Field, Lines, Total, TotalRole};

static TOTAL_ROLES: Lazy<Vec<(TotalRole, Regex)>> = Lazy::new(|| {
    let ci = |p: &str| Regex::new(&format!("(?i){p}")).unwrap();
    vec![
        (TotalRole::Balance, ci(r"נותר|יתרה|balance")),
        (TotalRole::AfterDiscount, ci(r"אחרי הנחה|after discount")),
        (TotalRole::Discount, ci(r"הנחה|discount")),
        (TotalRole::Vat, ci(r#"^מע"מ|^מע״מ|^vat(?-u:\b)"#)),
        (
            TotalRole::Subtotal,
            ci(r#"מחיר כולל|סה"כ לפני|סה״כ לפני|סכום ביניים|ללא מע"מ|subtotal"#),
        ),
        (TotalRole::Total, ci(r#"סה"כ|סה״כ|לתשלום|^total"#)),
    ]
});
static PERCENT_IN_LABEL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\(\s*([-−]?[0-9]+(?:\.[0-9]+)?)\s*%\s*([-−])?\s*\)").unwrap());

/// What a label in the totals box stands for.
pub fn total_role(label: &str) -> Option<TotalRole> {
    TOTAL_ROLES
        .iter()
        .find(|(_, p)| p.is_match(label))
        .map(|(r, _)| *r)
}

pub fn totals_from(fields: &[Field]) -> Vec<Total> {
    fields
        .iter()
        .filter_map(|f| {
            let amount = parse_amount(&f.value)?;
            let role = total_role(&f.label)?;
            if amount.percent {
                return None;
            }
            let percent = PERCENT_IN_LABEL.captures(&f.label).map(|m| {
                let v: f64 = m[1].replace('−', "-").parse().unwrap_or(f64::NAN);
                if m.get(2).is_some() {
                    -v
                } else {
                    v
                }
            });
            Some(Total {
                label: f.label.clone(),
                value: amount.value,
                currency: amount.currency,
                percent,
                role,
                page: f.page,
            })
        })
        .collect()
}

fn check(name: &str, expected: f64, actual: f64) -> Check {
    Check {
        name: name.into(),
        ok: (actual - expected).abs() <= 0.011,
        expected: Some(round2(expected)),
        actual: Some(actual),
        diff: Some(round2(actual - expected)),
        label: None,
        sign: None,
        checked: None,
        failed: None,
    }
}

/// Sum of lines vs subtotal, every row's arithmetic, discount, VAT, grand total.
/// A check that cannot run is absent.
pub fn totals_checks(lines: Option<&Lines>, totals: &[Total]) -> Vec<Check> {
    let mut checks = Vec::new();
    let by_role = |role: TotalRole| totals.iter().find(|t| t.role == role);
    let subtotal = by_role(TotalRole::Subtotal);
    let discount = by_role(TotalRole::Discount);
    let after = by_role(TotalRole::AfterDiscount);
    let vat = by_role(TotalRole::Vat);
    let total = by_role(TotalRole::Total);
    if let Some(lines) = lines {
        let sum = round2(
            lines
                .rows
                .iter()
                .map(|r| r.values.total.unwrap_or(0.0))
                .sum::<f64>(),
        );
        let target = subtotal
            .or(if vat.is_some() { after } else { None })
            .or(total);
        if let Some(t) = target {
            let mut c = check("lines-sum", sum, t.value);
            c.label = Some(t.label.clone());
            checks.push(c);
        }
        let bad: Vec<FailedRow> = lines
            .rows
            .iter()
            .filter_map(|r| {
                let c = r.check.as_ref().filter(|c| !c.ok)?;
                Some(FailedRow {
                    index: r.values.index,
                    page: r.page,
                    ok: c.ok,
                    expected: c.expected,
                    diff: c.diff,
                })
            })
            .collect();
        checks.push(Check {
            name: "line-arithmetic".into(),
            ok: bad.is_empty(),
            expected: None,
            actual: None,
            diff: None,
            label: None,
            sign: None,
            checked: Some(lines.rows.iter().filter(|r| r.check.is_some()).count()),
            failed: Some(bad),
        });
    }
    if let (Some(s), Some(d), Some(a)) = (subtotal, discount, after) {
        // The sign is printed inconsistently ("0.32-" for a surcharge, "0.36"
        // for a discount); the after-discount line settles it.
        let minus = s.value - d.value.abs();
        let plus = s.value + d.value.abs();
        let best = if (minus - a.value).abs() <= (plus - a.value).abs() {
            minus
        } else {
            plus
        };
        let mut c = check("discount", best, a.value);
        c.sign = Some(if best == minus { "minus" } else { "plus" }.into());
        checks.push(c);
    }
    let base = after.or(subtotal);
    if let (Some(v), Some(b)) = (vat, base) {
        if let Some(p) = v.percent {
            checks.push(check("vat", b.value * (p / 100.0), v.value));
        }
    }
    if let (Some(t), Some(b), Some(v)) = (total, base, vat) {
        checks.push(check("grand-total", b.value + v.value, t.value));
    }
    checks
}
