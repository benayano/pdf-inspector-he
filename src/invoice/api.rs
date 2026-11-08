//! The invoice layer behind one call with JSON in and out, so every binding
//! (the C ABI that Dart calls, wasm) is a thin wrapper over the same code.
//!
//! `call(method, request, bytes)` returns `{"ok": true, "result": …}` or
//! `{"ok": false, "error": "…"}`; it never panics on bad input.
//!
//! | method        | bytes | request                                                        | result |
//! |---------------|-------|----------------------------------------------------------------|--------|
//! | `read_invoice`| PDF   | `{tuning?, alternatives?, pages?, markdown?, repair_request?, context?}` | `{document, state}` |
//! | `apply_repair`| –     | `{state, answer, markdown?, context?}`                         | `{document, state, applied, rejected}` |
//! | `invoice_csv` | –     | `{state, bom?, excel_safe?}`                                   | `{csv}` |
//! | `classify`    | PDF   | –                                                              | `{pdf_type, page_count, pages_needing_ocr, confidence}` |
//! | `process_pdf` | PDF   | `{tuning?, pages?, page_markers?}`                             | `{pdf_type, page_count, markdown}` |
//! | `list_knobs`  | –     | –                                                              | `{knobs: [{name, unit, auto, effect}]}` |
//! | `version`     | –     | –                                                              | `{version, document_schema}` |
//!
//! `state` is opaque to the caller: the parsed invoice plus the rows and
//! pages of its repair request, handed back to `apply_repair` and
//! `invoice_csv`. The model is never called here: the caller sends
//! `document.repair.prompt` with `document.repair.schema` and passes the
//! parsed answer to `apply_repair`.
use serde::Deserialize;
use serde_json::{json, Value};

use super::document::{invoice_document, DocumentOptions, InvoiceRead, DOCUMENT_SCHEMA};
use super::model::Invoice;
use super::read::{pdf_type_name, read_invoice, DEFAULT_ALTERNATIVES};
use super::records::{to_csv, to_records, RECORD_COLUMNS};
use super::repair::{apply_repair, assess, repair_request, RequestOptions, Status};
use crate::tuning::{with_tuning, Tuning, KNOBS};

/// What `apply_repair` and `invoice_csv` need back from a read.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct State {
    pub pdf_type: Option<String>,
    pub invoice: Invoice,
    /// 0-based rows the repair request listed (a fix to another row is refused).
    #[serde(default)]
    pub rows: Vec<usize>,
    #[serde(default)]
    pub needs_pages: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ReadRequest {
    tuning: String,
    alternatives: Option<Vec<String>>,
    pages: Option<Vec<u32>>,
    markdown: bool,
    repair_request: Option<bool>,
    context: String,
}

#[derive(Debug, Deserialize)]
struct ApplyRequest {
    state: State,
    answer: Value,
    #[serde(default)]
    context: String,
}

#[derive(Debug, Deserialize)]
struct CsvRequest {
    state: State,
    #[serde(default)]
    bom: bool,
    #[serde(default)]
    excel_safe: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ProcessRequest {
    tuning: String,
    pages: Option<Vec<u32>>,
    page_markers: Option<bool>,
}

fn parse<T: for<'de> Deserialize<'de>>(request: &str) -> Result<T, String> {
    let text = if request.trim().is_empty() {
        "{}"
    } else {
        request
    };
    serde_json::from_str(text).map_err(|e| format!("bad request: {e}"))
}

fn state_of(invoice: &Invoice, pdf_type: Option<String>, context: &str) -> State {
    let a = assess(invoice, 0.4);
    let (rows, needs_pages) = if a.status == Status::Repairable {
        let req = repair_request(
            invoice,
            &RequestOptions {
                context: context.to_string(),
                ..Default::default()
            },
        );
        (req.rows, req.needs_pages)
    } else {
        (vec![], false)
    };
    State {
        pdf_type,
        invoice: invoice.clone(),
        rows,
        needs_pages,
    }
}

fn read(request: &str, bytes: &[u8]) -> Result<Value, String> {
    let r: ReadRequest = parse(request)?;
    let alternatives: Vec<&str> = match &r.alternatives {
        Some(a) => a.iter().map(String::as_str).collect(),
        None => DEFAULT_ALTERNATIVES.to_vec(),
    };
    let result = read_invoice(bytes, &r.tuning, &alternatives, r.pages.as_deref())
        .map_err(|e| e.to_string())?;
    let options = DocumentOptions {
        markdown: r.markdown,
        no_repair_request: r.repair_request == Some(false),
        context: r.context.clone(),
    };
    let document = invoice_document(&result, &options);
    let state = result
        .invoice
        .as_ref()
        .map(|i| state_of(i, result.pdf_type.clone(), &r.context));
    Ok(json!({ "document": document, "state": state }))
}

fn apply(request: &str) -> Result<Value, String> {
    let r: ApplyRequest = parse(request)?;
    let out = apply_repair(
        &r.state.invoice,
        &r.answer,
        &r.state.rows,
        r.state.needs_pages,
    );
    let read = InvoiceRead {
        pdf_type: r.state.pdf_type.clone(),
        invoice: Some(out.invoice.clone()),
        assessment: None,
        auto_fixed: vec![],
        markdown: None,
    };
    let document = invoice_document(
        &read,
        &DocumentOptions {
            context: r.context.clone(),
            ..Default::default()
        },
    );
    // The rows listed stay those of the first request: a second answer may
    // only touch what was asked about.
    let state = State {
        invoice: out.invoice,
        ..r.state
    };
    Ok(
        json!({ "document": document, "state": state, "applied": out.applied, "rejected": out.rejected }),
    )
}

fn process(request: &str, bytes: &[u8]) -> Result<Value, String> {
    let r: ProcessRequest = parse(request)?;
    let tuning = Tuning::parse(&r.tuning)?;
    with_tuning(tuning, || {
        let mut options = crate::PdfOptions::new();
        if let Some(pages) = &r.pages {
            options = options.pages(pages.iter().copied());
        }
        options.markdown.include_page_numbers = r.page_markers.unwrap_or(true);
        let result =
            crate::process_pdf_mem_with_options(bytes, options).map_err(|e| e.to_string())?;
        Ok(json!({
            "pdf_type": pdf_type_name(result.pdf_type),
            "page_count": result.page_count,
            "markdown": result.markdown.unwrap_or_default(),
        }))
    })
}

fn dispatch(method: &str, request: &str, bytes: &[u8]) -> Result<Value, String> {
    let needs_pdf = matches!(method, "read_invoice" | "classify" | "process_pdf");
    if needs_pdf && bytes.is_empty() {
        return Err(format!("{method} needs the PDF bytes"));
    }
    match method {
        "read_invoice" => read(request, bytes),
        "apply_repair" => apply(request),
        "invoice_csv" => {
            let r: CsvRequest = parse(request)?;
            Ok(json!({ "csv": to_csv(&to_records(&r.state.invoice), &RECORD_COLUMNS, r.bom, r.excel_safe) }))
        }
        "classify" => {
            let c = crate::classify_pdf_mem(bytes).map_err(|e| e.to_string())?;
            Ok(json!({
                "pdf_type": pdf_type_name(c.pdf_type),
                "page_count": c.page_count,
                "pages_needing_ocr": c.pages_needing_ocr,
                "confidence": c.confidence,
            }))
        }
        "process_pdf" => process(request, bytes),
        "list_knobs" => Ok(json!({
            "knobs": KNOBS.iter().map(|k| json!({ "name": k.name, "unit": k.unit, "auto": k.auto, "effect": k.effect })).collect::<Vec<_>>()
        })),
        "version" => Ok(json!({ "version": env!("CARGO_PKG_VERSION"), "document_schema": DOCUMENT_SCHEMA })),
        other => Err(format!(
            "unknown method `{other}` (known: read_invoice, apply_repair, invoice_csv, classify, process_pdf, list_knobs, version)"
        )),
    }
}

/// One call, JSON in and out; a panic inside becomes an error, not a crash.
pub fn call(method: &str, request: &str, bytes: &[u8]) -> Value {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dispatch(method, request, bytes)
    }));
    match outcome {
        Ok(Ok(result)) => json!({ "ok": true, "result": result }),
        Ok(Err(error)) => json!({ "ok": false, "error": error }),
        Err(panic) => {
            let message = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown".into());
            json!({ "ok": false, "error": format!("internal error: {message}") })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_values() {
        assert_eq!(call("nope", "", &[])["ok"], false);
        assert!(call("read_invoice", "{}", &[])["error"]
            .as_str()
            .unwrap()
            .contains("needs the PDF"));
        assert!(call("read_invoice", "{", b"x")["error"]
            .as_str()
            .unwrap()
            .starts_with("bad request"));
        assert_eq!(call("classify", "", b"not a pdf")["ok"], false);
        assert_eq!(
            call("version", "", &[])["result"]["document_schema"],
            DOCUMENT_SCHEMA
        );
        assert_eq!(
            call("list_knobs", "", &[])["result"]["knobs"]
                .as_array()
                .unwrap()
                .len(),
            KNOBS.len()
        );
    }
}
