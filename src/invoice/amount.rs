//! Amounts as invoices print them.
use once_cell::sync::Lazy;
use regex::Regex;

use super::model::Amount;

static CURRENCY_FIRST: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"^(₪|\$|€|ש"ח|ש״ח)\s*(.+)$"#).unwrap());
static NUMBER: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\(?\s*([-−])?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]+))?\s*(%)?\s*([-−])?\s*\)?\s*(.*)$")
        .unwrap()
});
static UNIT_TEXT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"^[\p{L}"'׳״.₪$€%]+(?: [\p{L}"'׳״.]+)?$"#).unwrap());

fn currency_of(unit: &str) -> Option<&'static str> {
    Some(match unit {
        "ש\"ח" | "ש״ח" | "שח" | "₪" | "NIS" | "ILS" => "ILS",
        "$" | "USD" => "USD",
        "€" | "EUR" => "EUR",
        _ => return None,
    })
}

/// Parses "1,210.10", "461.54-" (trailing minus), "-461.54", "(0.04%-)",
/// "101.69 ש"ח", "60.80 מטר", "1.00 יח'", "38.00%", "₪ 12.5". None for
/// anything that is not one amount (dates, codes, sentences).
pub fn parse_amount(raw: &str) -> Option<Amount> {
    let mut text = raw.replace('\u{a0}', " ").trim().to_string();
    if text.is_empty() {
        return None;
    }
    let mut unit: Option<String> = None;
    if let Some(c) = CURRENCY_FIRST.captures(&text) {
        unit = Some(c[1].to_string());
        text = c[2].trim().to_string();
    }
    let m = NUMBER.captures(&text)?;
    let lead = m.get(1).is_some();
    let int = m.get(2)?.as_str();
    let frac = m.get(3).map(|f| f.as_str());
    let pct = m.get(4).is_some();
    let trail = m.get(5).is_some();
    let rest = m.get(6).map_or("", |r| r.as_str()).trim();
    if !rest.is_empty() {
        if unit.is_some() || !UNIT_TEXT.is_match(rest) || rest.chars().count() > 12 {
            return None;
        }
        unit = Some(rest.to_string());
    }
    if lead && trail {
        return None;
    }
    let digits = format!(
        "{}{}",
        int.replace(',', ""),
        frac.map(|f| format!(".{f}")).unwrap_or_default()
    );
    let mut value: f64 = digits.parse().ok()?;
    if lead || trail {
        value = -value;
    }
    let percent = pct || unit.as_deref() == Some("%");
    let currency = unit.as_deref().and_then(currency_of).map(String::from);
    Some(Amount {
        value,
        unit: if percent { Some("%".into()) } else { unit },
        currency,
        percent,
        raw: raw.trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_ways_invoices_print_amounts() {
        let a = parse_amount("1,210.10").unwrap();
        assert_eq!((a.value, a.unit.clone()), (1210.10, None));
        assert_eq!(parse_amount("461.54-").unwrap().value, -461.54);
        assert_eq!(parse_amount("-461.54").unwrap().value, -461.54);
        let p = parse_amount("(0.04%-)").unwrap();
        assert_eq!((p.value, p.percent), (-0.04, true));
        let s = parse_amount("101.69 ש\"ח").unwrap();
        assert_eq!((s.value, s.currency.as_deref()), (101.69, Some("ILS")));
        let m = parse_amount("60.80 מטר").unwrap();
        assert_eq!((m.value, m.unit.as_deref()), (60.8, Some("מטר")));
        assert_eq!(
            parse_amount("1.00 יח'").unwrap().unit.as_deref(),
            Some("יח'")
        );
        assert_eq!(
            parse_amount("₪ 12.5").unwrap().currency.as_deref(),
            Some("ILS")
        );
        for no in [
            "23/10/22",
            "SH22039076",
            "LK-1144501",
            "מסילה 1.2 3 מטר",
            "",
            "21:01",
            "-5-",
        ] {
            assert!(parse_amount(no).is_none(), "{no}");
        }
    }
}
