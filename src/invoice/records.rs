//! The invoice's own facts, one flat record per line, and CSV.
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::js::num_str;
use super::model::{Invoice, TotalRole, Values};

/// "31/08/26" or "31.08.2026" -> "2026-08-31".
pub fn iso_date(text: &str) -> Option<String> {
    static DATE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^([0-9]{1,2})[/.]([0-9]{1,2})[/.]([0-9]{2}|[0-9]{4})$").unwrap());
    let m = DATE.captures(text.trim())?;
    let (d, mo, y): (u32, u32, &str) = (m[1].parse().ok()?, m[2].parse().ok()?, m.get(3)?.as_str());
    let year: u32 = if y.len() == 2 {
        2000 + y.parse::<u32>().ok()?
    } else {
        y.parse().ok()?
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    Some(format!("{year}-{mo:02}-{d:02}"))
}

/// A line priced at a cent or less: a printed note ("לקח …"), not goods.
pub fn is_marker_line(v: &Values) -> bool {
    let price = v.unit_price.or(v.net_unit_price).unwrap_or(0.0).abs();
    v.total.is_some_and(|t| t.abs() <= 0.01) && price <= 0.01
}

/// "credit" when the header says זיכוי / credit note.
pub fn document_type(invoice: &Invoice) -> &'static str {
    static CREDIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)זיכוי|credit note").unwrap());
    let text: Vec<&str> = invoice
        .header
        .blocks
        .iter()
        .map(|b| b.text.as_str())
        .collect();
    if CREDIT.is_match(&text.join("\n")) {
        "credit"
    } else {
        "invoice"
    }
}

/// The invoice's own facts; null where not found, never guessed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InvoiceInfo {
    pub document_type: String,
    pub invoice_number: Option<String>,
    pub invoice_date: Option<String>,
    pub supplier_name: Option<String>,
    pub supplier_tax_id: Option<String>,
    pub subtotal: Option<f64>,
    pub discount: Option<f64>,
    pub after_discount: Option<f64>,
    pub vat_rate: Option<f64>,
    pub vat: Option<f64>,
    pub total: Option<f64>,
    pub currency: Option<String>,
    pub checks_ok: bool,
}

pub fn invoice_info(invoice: &Invoice) -> InvoiceInfo {
    static TAX: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)עוסק מורשה|^ח\.?\s?פ\.?$|^ע\.?\s?מ\.?$|^vat (no|number)|^tax id").unwrap()
    });
    static NUMBER: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)מספר חשבונית|מספר תעודה|invoice (no|number)").unwrap());
    static TITLE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"חשבונית[^\n]*?\s*([A-Z]{0,4}[0-9]{5,})").unwrap());
    static DATE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)תאריך חשבונית|^תאריך$|invoice date").unwrap());
    let fields = &invoice.header.fields;
    let first = |re: &Regex| {
        fields
            .iter()
            .find(|f| re.is_match(&f.label) && !f.value.is_empty())
    };
    let tax = first(&TAX);
    let supplier_block =
        tax.and_then(|t| invoice.header.blocks.iter().find(|b| b.fields.contains(t)));
    let invoice_number = first(&NUMBER).map(|f| f.value.clone()).or_else(|| {
        invoice
            .header
            .blocks
            .iter()
            .flat_map(|b| b.lines.iter())
            .find_map(|l| TITLE.captures(l).map(|m| m[1].to_string()))
    });
    let total = |role: TotalRole| invoice.totals.iter().find(|t| t.role == role);
    InvoiceInfo {
        document_type: document_type(invoice).into(),
        invoice_number,
        invoice_date: first(&DATE).and_then(|f| iso_date(&f.value)),
        supplier_name: supplier_block.and_then(|b| b.lines.first().cloned()),
        supplier_tax_id: tax
            .map(|t| {
                t.value
                    .chars()
                    .filter(|c| c.is_ascii_digit())
                    .collect::<String>()
            })
            .filter(|d| !d.is_empty()),
        subtotal: total(TotalRole::Subtotal).map(|t| t.value),
        discount: total(TotalRole::Discount).map(|t| t.value),
        after_discount: total(TotalRole::AfterDiscount).map(|t| t.value),
        vat_rate: total(TotalRole::Vat).and_then(|t| t.percent),
        vat: total(TotalRole::Vat).map(|t| t.value),
        total: total(TotalRole::Total).map(|t| t.value),
        currency: invoice.totals.iter().find_map(|t| t.currency.clone()),
        checks_ok: invoice.checks.iter().all(|c| c.ok),
    }
}

/// One flat record per item line, the invoice's facts repeated on each.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineRecord {
    pub invoice_number: Option<String>,
    pub invoice_date: Option<String>,
    pub supplier_name: Option<String>,
    pub supplier_tax_id: Option<String>,
    pub line_no: f64,
    pub page: u32,
    pub date: Option<String>,
    pub delivery_note: Option<String>,
    pub order_ref: Option<String>,
    pub sku: Option<String>,
    pub description: Option<String>,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub unit_price: Option<f64>,
    pub discount_pct: Option<f64>,
    pub net_unit_price: Option<f64>,
    pub line_total: Option<f64>,
    pub currency: Option<String>,
    pub check_ok: Option<bool>,
    pub check_diff: Option<f64>,
    pub site_text: Option<String>,
    pub marker: bool,
    pub is_return: bool,
}

/// Column order of [`to_records`] and [`to_csv`].
pub const RECORD_COLUMNS: [&str; 23] = [
    "invoice_number",
    "invoice_date",
    "supplier_name",
    "supplier_tax_id",
    "line_no",
    "page",
    "date",
    "delivery_note",
    "order_ref",
    "sku",
    "description",
    "quantity",
    "unit",
    "unit_price",
    "discount_pct",
    "net_unit_price",
    "line_total",
    "currency",
    "check_ok",
    "check_diff",
    "site_text",
    "marker",
    "is_return",
];

pub fn to_records(invoice: &Invoice) -> Vec<LineRecord> {
    let info = invoice_info(invoice);
    let Some(lines) = &invoice.lines else {
        return Vec::new();
    };
    let credit = info.document_type == "credit";
    lines
        .rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let v = &row.values;
            let currency = row
                .amounts
                .iter()
                .flatten()
                .find_map(|a| a.currency.clone())
                .or(info.currency.clone());
            LineRecord {
                invoice_number: info.invoice_number.clone(),
                invoice_date: info.invoice_date.clone(),
                supplier_name: info.supplier_name.clone(),
                supplier_tax_id: info.supplier_tax_id.clone(),
                line_no: v.index.unwrap_or((i + 1) as f64),
                page: row.page,
                date: v
                    .date
                    .as_deref()
                    .map(|d| iso_date(d).unwrap_or_else(|| d.to_string())),
                delivery_note: v.delivery_note.clone(),
                order_ref: v.order.clone(),
                sku: v.sku.clone(),
                description: v.description.clone(),
                quantity: v.quantity,
                unit: v.unit.clone(),
                unit_price: v.unit_price,
                discount_pct: v.discount,
                net_unit_price: v.net_unit_price,
                line_total: v.total,
                currency,
                check_ok: row.check.as_ref().map(|c| c.ok),
                check_diff: row.check.as_ref().map(|c| c.diff),
                site_text: v.site.clone(),
                marker: is_marker_line(v),
                is_return: !credit && v.total.unwrap_or(0.0) < 0.0,
            }
        })
        .collect()
}

/// A JSON value as JS `String(value)` writes it.
pub(crate) fn value_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => Some(num_str(n.as_f64().unwrap_or(f64::NAN))),
        other => Some(other.to_string()),
    }
}

pub(crate) fn csv_cell(v: &serde_json::Value, excel_safe: bool) -> String {
    let Some(mut text) = value_text(v) else {
        return String::new();
    };
    // Text from a PDF that starts like a formula would run as one in Excel.
    if excel_safe && v.is_string() && text.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        text = format!("'{text}");
    }
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

/// CSV with a header row and CRLF line ends. For Excel (`bom`, `excel_safe`):
/// a BOM and formula-like text prefixed with '. For a database: neither.
pub fn to_csv<T: Serialize>(
    records: &[T],
    columns: &[&str],
    bom: bool,
    excel_safe: bool,
) -> String {
    let mut lines = vec![columns
        .iter()
        .map(|c| csv_cell(&serde_json::Value::String((*c).into()), false))
        .collect::<Vec<_>>()
        .join(",")];
    for r in records {
        let value = serde_json::to_value(r).unwrap_or_default();
        lines.push(
            columns
                .iter()
                .map(|c| {
                    csv_cell(
                        value.get(*c).unwrap_or(&serde_json::Value::Null),
                        excel_safe,
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    format!(
        "{}{}\r\n",
        if bom { "\u{feff}" } else { "" },
        lines.join("\r\n")
    )
}
