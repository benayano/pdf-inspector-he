//! The invoice as ONE JSON document (`pdf-inspector-he/invoice-document@1`,
//! described in `he/invoice-document.schema.json`): what a program, an agent
//! tool or a database import gets back from a read.
//!
//! Lines carry only line fields (the invoice's own facts are once, in
//! `invoice`); every line says whether its arithmetic closes; a repaired line
//! says why. `repair` holds the compact request a model would get.
use serde_json::{json, Map, Value};

use super::model::Invoice;
use super::records::{invoice_info, to_records};
use super::repair::{assess, repair_request, Assessment, RequestOptions, Status};

pub const DOCUMENT_SCHEMA: &str = "pdf-inspector-he/invoice-document@1";

/// Line fields of a document line, in order (the invoice-level fields of
/// `to_records` are left out).
pub const LINE_FIELDS: [&str; 20] = [
    "row",
    "line_no",
    "page",
    "date",
    "delivery_note",
    "order_ref",
    "sku",
    "description",
    "site_text",
    "quantity",
    "unit",
    "unit_price",
    "discount_pct",
    "net_unit_price",
    "line_total",
    "currency",
    "marker",
    "is_return",
    "check_ok",
    "check_diff",
];

/// A row taken from another reading of the document, with no model.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AutoFix {
    /// 1-based.
    pub row: usize,
    /// The knobs of the reading the row came from.
    pub tuning: String,
}

/// What a read gives: the PDF type, the invoice (none without a text layer),
/// what is wrong with it, and what was fixed with no model.
#[derive(Debug, Clone)]
pub struct InvoiceRead {
    pub pdf_type: Option<String>,
    pub invoice: Option<Invoice>,
    pub assessment: Option<Assessment>,
    pub auto_fixed: Vec<AutoFix>,
    pub markdown: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DocumentOptions {
    /// Include the extracted Markdown.
    pub markdown: bool,
    /// Leave out the repair request of a repairable invoice.
    pub no_repair_request: bool,
    /// One line for the model about the document (supplier, its quirks).
    pub context: String,
}

fn opt<T: serde::Serialize>(v: &Option<T>) -> Value {
    v.as_ref().map_or(Value::Null, |x| json!(x))
}

pub fn invoice_document(read: &InvoiceRead, options: &DocumentOptions) -> Value {
    let invoice = read.invoice.as_ref();
    let assessment = read
        .assessment
        .clone()
        .or_else(|| invoice.map(|i| assess(i, 0.4)));
    let mut doc = Map::new();
    doc.insert("schema".into(), json!(DOCUMENT_SCHEMA));
    doc.insert(
        "pdf".into(),
        json!({ "type": opt(&read.pdf_type), "pages": invoice.and_then(|i| i.lines.as_ref()).map_or(vec![], |l| l.pages.clone()) }),
    );
    doc.insert(
        "status".into(),
        json!(assessment.as_ref().map_or(Status::Unreadable, |a| a.status)),
    );
    doc.insert(
        "reasons".into(),
        json!(assessment.as_ref().map_or(vec![], |a| a.reasons.clone())),
    );
    for (k, v) in [
        ("invoice", Value::Null),
        ("header", json!({ "fields": [], "blocks": [] })),
        ("totals", json!([])),
        ("columns", json!([])),
        ("lines", json!([])),
        ("checks", json!([])),
        ("failed_rows", json!([])),
        ("auto_fixed", json!(read.auto_fixed)),
        ("repaired", json!([])),
        ("repair", Value::Null),
    ] {
        doc.insert(k.into(), v);
    }
    let markdown = |mut doc: Map<String, Value>| {
        if options.markdown {
            doc.insert(
                "markdown".into(),
                json!(read.markdown.clone().unwrap_or_default()),
            );
        }
        Value::Object(doc)
    };
    let Some(invoice) = invoice else {
        return markdown(doc);
    };

    doc.insert("invoice".into(), json!(invoice_info(invoice)));
    doc.insert(
        "header".into(),
        json!({
            "fields": invoice.header.fields.iter().map(|f| json!({ "label": f.label, "value": f.value })).collect::<Vec<_>>(),
            "blocks": invoice.header.blocks.iter().map(|b| json!({ "page": b.page, "text": b.text })).collect::<Vec<_>>(),
        }),
    );
    doc.insert(
        "totals".into(),
        invoice
            .totals
            .iter()
            .map(|t| json!({ "label": t.label, "role": t.role, "value": t.value, "percent": t.percent, "currency": t.currency }))
            .collect(),
    );
    let lines = invoice.lines.as_ref();
    doc.insert(
        "columns".into(),
        lines
            .map_or(vec![], |l| {
                l.columns
                    .iter()
                    .map(|c| json!({ "name": c.name, "role": c.role }))
                    .collect()
            })
            .into(),
    );
    let rows = lines.map_or(&[][..], |l| &l.rows[..]);
    let doc_lines: Vec<Value> = to_records(invoice)
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let record = json!(r);
            let mut line = Map::new();
            line.insert("row".into(), json!(i + 1));
            for f in &LINE_FIELDS[1..] {
                line.insert((*f).into(), record.get(*f).cloned().unwrap_or(Value::Null));
            }
            if let Some(rep) = rows.get(i).and_then(|r| r.repaired.as_ref()) {
                line.insert(
                    "repaired".into(),
                    if rep.why.is_empty() {
                        json!(true)
                    } else {
                        json!(rep.why)
                    },
                );
            }
            if rows.get(i).is_some_and(|r| r.inserted) {
                line.insert("inserted".into(), json!(true));
            }
            Value::Object(line)
        })
        .collect();
    let repaired: Vec<usize> = doc_lines
        .iter()
        .filter(|l| l.get("repaired").is_some() || l.get("inserted").is_some())
        .filter_map(|l| l["row"].as_u64().map(|n| n as usize))
        .collect();
    doc.insert("lines".into(), json!(doc_lines));
    doc.insert("repaired".into(), json!(repaired));
    let checks: Vec<Value> = invoice
        .checks
        .iter()
        .map(|c| {
            let mut out = Map::new();
            out.insert("name".into(), json!(c.name));
            out.insert("ok".into(), json!(c.ok));
            for (k, v) in [
                ("expected", c.expected),
                ("actual", c.actual),
                ("diff", c.diff),
            ] {
                if let Some(v) = v {
                    out.insert(k.into(), json!(v));
                }
            }
            for (k, v) in [("label", &c.label), ("sign", &c.sign)] {
                if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
                    out.insert(k.into(), json!(v));
                }
            }
            Value::Object(out)
        })
        .collect();
    doc.insert("checks".into(), json!(checks));
    doc.insert(
        "failed_rows".into(),
        json!(assessment.as_ref().map_or(vec![], |a| a
            .failed_rows
            .iter()
            .map(|i| i + 1)
            .collect::<Vec<_>>())),
    );
    if !options.no_repair_request
        && assessment
            .as_ref()
            .is_some_and(|a| a.status == Status::Repairable)
    {
        let req = repair_request(
            invoice,
            &RequestOptions {
                context: options.context.clone(),
                ..Default::default()
            },
        );
        doc.insert(
            "repair".into(),
            json!({
                "needs_pages": req.needs_pages,
                "pages": req.pages,
                "rows": req.rows.iter().map(|i| i + 1).collect::<Vec<_>>(),
                "prompt": req.prompt,
                "schema": req.schema,
            }),
        );
    }
    markdown(doc)
}
