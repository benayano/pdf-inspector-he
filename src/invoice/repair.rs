//! Repair: the model works WITH the extractor's result, not instead of it.
//!
//! [`assess`] says what is wrong; [`auto_repair`] takes failing rows from
//! other readings of the document with no model; [`repair_request`] builds a
//! compact request (only the failing rows, as CSV); [`apply_repair`] keeps a
//! correction only when the arithmetic then closes. The library calls no
//! model: the caller sends the request and passes the parsed answer.
use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::js::{js_number, js_sort_by, num_str, round2};
use super::model::{Check, Invoice, Row, Values};
use super::records::{csv_cell, invoice_info};
use super::{check_line, recheck};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Repairable,
    Unreadable,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Repairable => "repairable",
            Status::Unreadable => "unreadable",
        }
    }
}

/// What is wrong with an invoice, and how it could be fixed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub status: Status,
    pub reasons: Vec<String>,
    /// Indexes into `lines.rows`.
    pub failed_rows: Vec<usize>,
    /// Failed checks other than `line-arithmetic`.
    pub failed_checks: Vec<Check>,
    /// A row is missing or extra: text alone cannot fix it.
    pub needs_pages: bool,
    pub pages: Vec<u32>,
}

/// `max_failed_share`: a table with more failing rows than this share (0.4)
/// was read wrong as a whole and is not repairable.
pub fn assess(invoice: &Invoice, max_failed_share: f64) -> Assessment {
    let Some(lines) = invoice.lines.as_ref().filter(|l| !l.rows.is_empty()) else {
        return Assessment {
            status: Status::Unreadable,
            reasons: vec!["no item table found".into()],
            failed_rows: vec![],
            failed_checks: vec![],
            needs_pages: true,
            pages: vec![],
        };
    };
    let failed_rows: Vec<usize> = lines
        .rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r.check.as_ref().is_some_and(|c| !c.ok))
        .map(|(i, _)| i)
        .collect();
    let ran: HashSet<&str> = invoice.checks.iter().map(|c| c.name.as_str()).collect();
    let failed_checks: Vec<Check> = invoice
        .checks
        .iter()
        .filter(|c| !c.ok && c.name != "line-arithmetic")
        .cloned()
        .collect();
    let mut reasons = Vec::new();
    if !ran.contains("lines-sum") {
        reasons.push("no printed total to check the lines against".to_string());
    }
    if !failed_rows.is_empty() {
        reasons.push(format!(
            "{} row(s) do not close: quantity x price != total",
            failed_rows.len()
        ));
    }
    for c in &failed_checks {
        reasons.push(format!(
            "{} is off by {}",
            c.name,
            c.diff.map_or("undefined".into(), num_str)
        ));
    }
    // Every row closes but the lines do not add up: a row is missing or extra.
    let missing_row = failed_checks.iter().any(|c| c.name == "lines-sum") && failed_rows.is_empty();
    if missing_row {
        reasons.push("every row closes but their sum does not: a row is missing or extra".into());
    }
    let pages: Vec<u32> = if missing_row {
        lines
            .pages
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    } else {
        failed_rows
            .iter()
            .map(|&i| lines.rows[i].page)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    };
    let n = lines.rows.len();
    let status = if !ran.contains("lines-sum") {
        Status::Unreadable
    } else if failed_rows.is_empty() && failed_checks.is_empty() {
        Status::Ok
    } else if failed_rows.len() as f64 > (3f64).max(n as f64 * max_failed_share)
        || (n >= 2 && failed_rows.len() == n)
    {
        reasons.push("too many rows fail: the table was read wrong as a whole".into());
        Status::Unreadable
    } else {
        Status::Repairable
    };
    Assessment {
        status,
        reasons,
        failed_rows,
        failed_checks,
        needs_pages: missing_row,
        pages,
    }
}

fn row_keys(rows: &[Row]) -> Vec<String> {
    let mut seen: HashMap<u32, usize> = HashMap::new();
    rows.iter()
        .map(|r| {
            let n = seen.entry(r.page).or_default();
            *n += 1;
            match r.values.index {
                Some(i) => format!("{}#{}", r.page, num_str(i)),
                None => format!("{}@{}", r.page, n),
            }
        })
        .collect()
}

/// Failing rows taken from other readings of the document, with no model:
/// the same row (page + printed line number, or position on the page) where
/// it closes there. Returns the invoice and (1-based row, alternative index).
pub fn auto_repair(invoice: &Invoice, alternatives: &[Invoice]) -> (Invoice, Vec<(usize, usize)>) {
    let Some(lines) = &invoice.lines else {
        return (invoice.clone(), vec![]);
    };
    let keys = row_keys(&lines.rows);
    let maps: Vec<HashMap<String, &Row>> = alternatives
        .iter()
        .map(|alt| {
            let rows = alt.lines.as_ref().map_or(&[][..], |l| &l.rows[..]);
            row_keys(rows).into_iter().zip(rows.iter()).collect()
        })
        .collect();
    let mut next = lines.rows.clone();
    let mut fixed = Vec::new();
    for (i, row) in lines.rows.iter().enumerate() {
        if row.check.as_ref().is_none_or(|c| c.ok) {
            continue;
        }
        for (a, map) in maps.iter().enumerate() {
            if let Some(candidate) = map
                .get(&keys[i])
                .filter(|c| c.check.as_ref().is_some_and(|c| c.ok))
            {
                next[i] = (*candidate).clone();
                fixed.push((i + 1, a));
                break;
            }
        }
    }
    if fixed.is_empty() {
        return (invoice.clone(), fixed);
    }
    let mut out = invoice.clone();
    out.lines.as_mut().expect("checked").rows = next;
    (recheck(&out), fixed)
}

/// Columns of the repair CSV; `row` is the id the answer uses.
pub const REPAIR_COLUMNS: [&str; 13] = [
    "row",
    "line_no",
    "page",
    "delivery_note",
    "sku",
    "description",
    "quantity",
    "unit",
    "unit_price",
    "discount_pct",
    "net_unit_price",
    "line_total",
    "check",
];

fn opt_num(v: Option<f64>) -> Value {
    v.map_or(Value::Null, |n| json!(n))
}
fn opt_str(v: &Option<String>) -> Value {
    v.as_ref().map_or(Value::Null, |s| json!(s))
}

/// The given rows (indexes) as compact CSV, `\n`-separated.
pub fn slim_csv(invoice: &Invoice, rows: &[usize], columns: &[&str]) -> String {
    let all = invoice.lines.as_ref().map_or(&[][..], |l| &l.rows[..]);
    let mut out = vec![columns.join(",")];
    for &i in rows {
        let Some(r) = all.get(i) else { continue };
        let v = &r.values;
        let check = match &r.check {
            None => String::new(),
            Some(c) if c.ok => "ok".into(),
            Some(c) => format!(
                "off by {} (expected {})",
                num_str(c.diff),
                num_str(c.expected)
            ),
        };
        let record = json!({
            "row": i + 1,
            "line_no": opt_num(v.index),
            "page": r.page,
            "delivery_note": opt_str(&v.delivery_note),
            "sku": opt_str(&v.sku),
            "description": opt_str(&v.description),
            "quantity": opt_num(v.quantity),
            "unit": opt_str(&v.unit),
            "unit_price": opt_num(v.unit_price),
            "discount_pct": opt_num(v.discount),
            "net_unit_price": opt_num(v.net_unit_price),
            "line_total": opt_num(v.total),
            "check": check,
        });
        out.push(
            columns
                .iter()
                .map(|c| csv_cell(record.get(*c).unwrap_or(&Value::Null), false))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    out.join("\n")
}

/// JSON schema of the model's answer.
pub fn repair_schema() -> Value {
    let number = || json!({ "type": "number" });
    json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["fixes", "inserts", "unreadable", "notes"],
      "properties": {
        "fixes": {
          "type": "array",
          "description": "one entry per listed row you correct; leave out rows that are right",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["row", "quantity", "unit_price", "discount_pct", "line_total", "why"],
            "properties": {
              "row": { "type": "integer", "description": "the `row` value from the CSV" },
              "quantity": { "type": "number", "description": "negative only if printed negative (a returned item)" },
              "unit_price": { "type": "number", "description": "price per unit before the line discount, as printed" },
              "discount_pct": { "type": "number", "description": "line discount percent as printed; 0 if none" },
              "line_total": { "type": "number", "description": "the row's printed total" },
              "why": { "type": "string", "description": "one short sentence: what was misread" }
            }
          }
        },
        "inserts": {
          "type": "array",
          "description": "only when page images are attached: rows printed on the page that the CSV lacks",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["after_row", "line_no", "delivery_note", "sku", "description", "quantity", "unit", "unit_price", "discount_pct", "line_total"],
            "properties": {
              "after_row": { "type": "integer", "description": "the `row` it follows (0 = before the first)" },
              "line_no": { "type": "integer", "description": "the printed line number; 0 if none" },
              "delivery_note": { "type": "string" },
              "sku": { "type": "string" },
              "description": { "type": "string", "description": "as printed, Hebrew in reading order" },
              "quantity": number(),
              "unit": { "type": "string" },
              "unit_price": number(),
              "discount_pct": number(),
              "line_total": number()
            }
          }
        },
        "unreadable": { "type": "array", "description": "rows you cannot settle from what you were given", "items": { "type": "integer" } },
        "notes": { "type": "string", "description": "anything a person should know; \"\" if nothing" }
      }
    })
}

/// A compact request for a model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairRequest {
    pub status: Status,
    pub prompt: String,
    pub schema: Value,
    /// Row indexes sent.
    pub rows: Vec<usize>,
    pub pages: Vec<u32>,
    /// Attach these pages: a row is missing.
    pub needs_pages: bool,
}

#[derive(Debug, Clone)]
pub struct RequestOptions {
    pub context: String,
    pub neighbours: usize,
    pub max_rows: usize,
    /// Send every row when the table is this short.
    pub all_rows_up_to: usize,
}

impl Default for RequestOptions {
    fn default() -> Self {
        RequestOptions {
            context: String::new(),
            neighbours: 1,
            max_rows: 60,
            all_rows_up_to: 25,
        }
    }
}

fn totals_line(invoice: &Invoice) -> String {
    let info = invoice_info(invoice);
    let mut parts: Vec<String> = Vec::new();
    if let Some(n) = info.invoice_number.filter(|n| !n.is_empty()) {
        parts.push(format!("invoice {n}"));
    }
    if let Some(d) = info.invoice_date.filter(|d| !d.is_empty()) {
        parts.push(d);
    }
    for t in &invoice.totals {
        parts.push(format!("{} = {}", t.label, num_str(t.value)));
    }
    parts.join("; ")
}

fn js_opt(v: Option<f64>) -> String {
    v.map_or("undefined".into(), num_str)
}

/// The failing rows (± neighbours) as CSV, the failed checks, the totals.
pub fn repair_request(invoice: &Invoice, options: &RequestOptions) -> RepairRequest {
    let a = assess(invoice, 0.4);
    let rows = invoice.lines.as_ref().map_or(&[][..], |l| &l.rows[..]);
    let mut pick: BTreeSet<usize> = BTreeSet::new();
    if a.needs_pages || rows.len() <= options.all_rows_up_to {
        pick.extend(0..rows.len());
    } else {
        for &i in &a.failed_rows {
            let from = i.saturating_sub(options.neighbours);
            pick.extend((from..=i + options.neighbours).filter(|&j| j < rows.len()));
        }
    }
    let indexes: Vec<usize> = pick.into_iter().take(options.max_rows).collect();
    let mut failed: Vec<String> = a
        .failed_rows
        .iter()
        .map(|&i| {
            let r = &rows[i];
            format!(
                "row {}: {} x price != {} (off by {})",
                i + 1,
                js_opt(r.values.quantity),
                js_opt(r.values.total),
                r.check
                    .as_ref()
                    .map_or("undefined".into(), |c| num_str(c.diff))
            )
        })
        .collect();
    failed.extend(a.failed_checks.iter().map(|c| {
        format!(
            "{}: printed {}, from the rows {} (off by {})",
            c.name,
            js_opt(c.actual),
            js_opt(c.expected),
            js_opt(c.diff)
        )
    }));
    let mut lines: Vec<String> = vec![
        "An invoice was read by a PDF extractor. Most of it checks; the items below do not.".into(),
        if options.context.is_empty() { String::new() } else { format!("Context: {}", options.context) },
        "Rows are listed as CSV in reading order. Hebrew text is already in reading order: do not reverse it.".into(),
        "Typical misreads: two adjacent numbers run together or split (\"31.2\" for \"1.2 3\"), a decimal point lost,".into(),
        "a minus sign printed after the number (\"461.54-\"), a quantity printed with its unit.".into(),
        "Correct only what the evidence supports. A row whose printed numbers really disagree is the supplier's".into(),
        "error, not a misread: list it in `unreadable` and do not invent a value.".into(),
        if a.needs_pages {
            "The page images are attached: a row seems missing or extra. Compare them with the CSV; add missing rows in `inserts`.".into()
        } else {
            "No page images are attached; answer from the CSV only (use `inserts` only if images are attached).".into()
        },
        String::new(),
        format!("TOTALS: {}", totals_line(invoice)),
        "FAILED:".into(),
    ];
    lines.extend(failed.into_iter().map(|f| format!("- {f}")));
    lines.push(String::new());
    lines.push("ROWS:".into());
    lines.push(slim_csv(invoice, &indexes, &REPAIR_COLUMNS));
    let prompt = lines
        .into_iter()
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    RepairRequest {
        status: a.status,
        prompt,
        schema: repair_schema(),
        rows: indexes,
        pages: a.pages,
        needs_pages: a.needs_pages,
    }
}

/// What applying an answer did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RepairOutcome {
    pub invoice: Invoice,
    pub applied: Vec<Value>,
    pub rejected: Vec<Value>,
    pub status: Status,
    pub reasons: Vec<String>,
}

fn number_of(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
        _ => None,
    }
}

fn with_reason(v: &Value, reason: String) -> Value {
    let mut m = v.as_object().cloned().unwrap_or_else(Map::new);
    m.insert("reason".into(), json!(reason));
    Value::Object(m)
}

fn text_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => super::records::value_text(other).unwrap_or_default(),
    }
}

/// Applies a model's answer (REPAIR_SCHEMA). A fix is kept only for a listed
/// row and only if that row then closes; inserts only when pages were asked
/// for and the lines then add up. Everything is checked again.
pub fn apply_repair(
    invoice: &Invoice,
    answer: &Value,
    rows_listed: &[usize],
    needs_pages: bool,
) -> RepairOutcome {
    let mut applied = Vec::new();
    let mut rejected = Vec::new();
    let listed: HashSet<usize> = rows_listed.iter().copied().collect();
    let mut rows: Vec<Row> = invoice
        .lines
        .as_ref()
        .map_or_else(Vec::new, |l| l.rows.clone());
    let empty = Vec::new();

    for fix in answer
        .get("fixes")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
    {
        let at = js_number(&text_of(fix.get("row"))) - 1.0;
        let i = if at.is_finite() && at >= 0.0 && at.fract() == 0.0 {
            Some(at as usize)
        } else {
            None
        };
        let Some(i) = i.filter(|i| listed.contains(i) && *i < rows.len()) else {
            rejected.push(with_reason(fix, "row was not in the request".into()));
            continue;
        };
        let nums: Vec<Option<f64>> = ["quantity", "unit_price", "discount_pct", "line_total"]
            .iter()
            .map(|k| number_of(fix.get(*k)))
            .collect();
        let [Some(quantity), Some(unit_price), Some(discount), Some(line_total)] = nums[..] else {
            rejected.push(with_reason(fix, "not a number".into()));
            continue;
        };
        let before = rows[i].clone();
        let mut values = before.values.clone();
        values.quantity = Some(quantity);
        values.unit_price = Some(unit_price);
        values.discount = (discount != 0.0).then_some(discount);
        values.total = Some(round2(line_total));
        values.net_unit_price = None; // the corrected price stands for both
        let check = check_line(&values);
        if let Some(c) = check.as_ref().filter(|c| !c.ok) {
            rejected.push(with_reason(
                fix,
                format!("still off by {}", num_str(c.diff)),
            ));
            continue;
        }
        let why = text_of(fix.get("why"));
        rows[i] = Row {
            values,
            check,
            repaired: Some(super::model::Repaired {
                why: why.clone(),
                from: before.values,
            }),
            ..before
        };
        applied.push(json!({ "row": i + 1, "why": why }));
    }

    let inserts = answer
        .get("inserts")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    if !inserts.is_empty() && !needs_pages {
        for ins in inserts {
            rejected.push(with_reason(
                ins,
                "no pages were attached; inserts are not taken".into(),
            ));
        }
    } else if !inserts.is_empty() {
        let mut candidate = rows.clone();
        let mut sorted: Vec<&Value> = inserts.iter().collect();
        // From the last position back, so earlier `after_row` values stay true.
        js_sort_by(&mut sorted, |x, y| {
            js_number(&text_of(y.get("after_row"))) - js_number(&text_of(x.get("after_row")))
        });
        let mut added = Vec::new();
        for ins in sorted {
            let nums: Vec<Option<f64>> = ["quantity", "unit_price", "discount_pct", "line_total"]
                .iter()
                .map(|k| number_of(ins.get(*k)))
                .collect();
            let [Some(quantity), Some(unit_price), Some(discount), Some(line_total)] = nums[..]
            else {
                rejected.push(with_reason(ins, "not a number".into()));
                continue;
            };
            let after = js_number(&text_of(ins.get("after_row")));
            let after = if after.is_nan() { 0.0 } else { after };
            let at = (after.max(0.0) as usize).min(candidate.len());
            let s = |k: &str| Some(text_of(ins.get(k))).filter(|t| !t.is_empty());
            let values = Values {
                index: number_of(ins.get("line_no")).filter(|n| *n != 0.0),
                delivery_note: s("delivery_note"),
                sku: s("sku"),
                description: ins
                    .get("description")
                    .and_then(Value::as_str)
                    .map(String::from),
                quantity: Some(quantity),
                unit: s("unit"),
                unit_price: Some(unit_price),
                discount: (discount != 0.0).then_some(discount),
                total: Some(round2(line_total)),
                ..Values::default()
            };
            let page = candidate.get(at.saturating_sub(1)).map_or(1, |r| r.page);
            candidate.insert(
                at,
                Row {
                    page,
                    cells: vec![],
                    amounts: vec![],
                    values,
                    check: None,
                    repaired: None,
                    inserted: true,
                },
            );
            added.push(ins);
        }
        let mut trial = invoice.clone();
        if let Some(l) = trial.lines.as_mut() {
            l.rows = candidate.clone();
        }
        let trial = recheck(&trial);
        let sum_ok = trial
            .checks
            .iter()
            .find(|c| c.name == "lines-sum")
            .is_some_and(|c| c.ok);
        let rows_ok = trial.lines.as_ref().is_some_and(|l| {
            l.rows
                .iter()
                .all(|r| !r.inserted || r.check.as_ref().is_none_or(|c| c.ok))
        });
        if sum_ok && rows_ok {
            rows = candidate;
            for ins in added {
                applied.push(json!({ "inserted_after": ins.get("after_row").cloned().unwrap_or(Value::Null), "description": ins.get("description").cloned().unwrap_or(Value::Null) }));
            }
        } else {
            for ins in added {
                rejected.push(with_reason(
                    ins,
                    "the lines still do not add up with it".into(),
                ));
            }
        }
    }

    let mut out = invoice.clone();
    if let Some(l) = out.lines.as_mut() {
        l.rows = rows;
    }
    let out = recheck(&out);
    let a = assess(&out, 0.4);
    RepairOutcome {
        invoice: out,
        applied,
        rejected,
        status: a.status,
        reasons: a.reasons,
    }
}
