//! The Rust invoice layer against what the JS layer produced on the corpus
//! (he/fixtures/golden/, written by he/tools/goldens.mjs). Numbers within
//! 1e-9, objects compared key by key, `amounts` (an intermediate the
//! goldens leave out) and `details` (added after the JS layer; held by
//! `details_of_the_corpus` below) ignored.
use std::path::Path;

use pdf_inspector::invoice::{
    parse_invoice_items, read::extract, to_csv, to_records, RECORD_COLUMNS,
};
use pdf_inspector::Tuning;
use serde_json::Value;

pub const CORPUS: [(&str, &str); 5] = [
    (
        "he/fixtures/invoices/print-to-pdf-5p.pdf",
        "print-to-pdf-5p",
    ),
    ("he/fixtures/invoices/priority-1p.pdf", "priority-1p"),
    ("he/fixtures/invoices/priority-2p.pdf", "priority-2p"),
    ("he/fixtures/invoices/priority-4p.pdf", "priority-4p"),
    (
        "he/fixtures/repair/priority-1p.misread-row11.pdf",
        "priority-1p.misread-row11",
    ),
];

fn golden(name: &str) -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("he/fixtures/golden/{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `actual` equals `expected` (the golden); differences listed by path.
pub fn same(actual: &Value, expected: &Value, path: &str, out: &mut Vec<String>) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            if (a - b).abs() > 1e-9 {
                out.push(format!("{path}: {a} != {b}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                match a.get(k) {
                    Some(av) => same(av, v, &format!("{path}.{k}"), out),
                    None => out.push(format!("{path}.{k}: missing")),
                }
            }
            for k in a
                .keys()
                .filter(|k| !b.contains_key(*k) && *k != "amounts" && *k != "details")
            {
                out.push(format!("{path}.{k}: extra"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(format!("{path}: {} items != {}", a.len(), b.len()));
            }
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                same(x, y, &format!("{path}[{i}]"), out);
            }
        }
        (a, b) if a != b => out.push(format!("{path}: {a} != {b}")),
        _ => {}
    }
}

fn read(pdf: &str) -> pdf_inspector::invoice::read::Extracted {
    let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(pdf)).unwrap();
    extract(&bytes, Tuning::default(), None).unwrap()
}

#[test]
fn parse_invoice_matches_the_js_layer() {
    let mut problems = Vec::new();
    for (pdf, name) in CORPUS {
        let x = read(pdf);
        let invoice = parse_invoice_items(&x.markdown, &x.items);
        let actual = serde_json::to_value(&invoice).unwrap();
        let expected = &golden(name)["invoice"];
        // Not an empty comparison: rows, header fields and checks are there.
        assert!(
            expected["lines"]["rows"].as_array().unwrap().len() >= 15,
            "{name}"
        );
        assert!(
            !expected["header"]["fields"].as_array().unwrap().is_empty(),
            "{name}"
        );
        assert!(expected["checks"].as_array().unwrap().len() >= 4, "{name}");
        let mut out = Vec::new();
        same(&actual, expected, name, &mut out);
        problems.extend(out.into_iter().take(15));
    }
    assert!(
        problems.is_empty(),
        "{} differences:\n{}",
        problems.len(),
        problems.join("\n")
    );
}

#[test]
fn the_comparison_catches_a_difference() {
    let mut out = Vec::new();
    let g = golden("priority-1p")["invoice"].clone();
    let mut changed = g.clone();
    changed["lines"]["rows"][10]["values"]["total"] = serde_json::json!(27.36);
    changed["header"]["blocks"][0]["text"] = serde_json::json!("x");
    same(&changed, &g, "p", &mut out);
    assert_eq!(out.len(), 2, "{out:?}");
}

#[test]
fn csv_matches_the_js_layer() {
    for (pdf, name) in CORPUS.iter().take(4) {
        let x = read(pdf);
        let invoice = parse_invoice_items(&x.markdown, &x.items);
        let csv = to_csv(&to_records(&invoice), &RECORD_COLUMNS, false, false);
        assert_eq!(csv, golden(name)["csv"].as_str().unwrap(), "{name}");
    }
}

fn bytes(pdf: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(pdf)).unwrap()
}

#[test]
fn document_matches_the_js_layer() {
    use pdf_inspector::invoice::document::{invoice_document, DocumentOptions};
    use pdf_inspector::invoice::read::{read_invoice, DEFAULT_ALTERNATIVES};
    let mut problems = Vec::new();
    for (pdf, name) in CORPUS {
        let read = read_invoice(&bytes(pdf), "", &DEFAULT_ALTERNATIVES, None).unwrap();
        let actual = invoice_document(&read, &DocumentOptions::default());
        let mut out = Vec::new();
        same(&actual, &golden(name)["document"], name, &mut out);
        problems.extend(out.into_iter().take(15));
    }
    let misread = golden("priority-1p.misread-row11");
    assert_eq!(misread["document"]["status"], "repairable");
    assert!(
        problems.is_empty(),
        "{} differences:\n{}",
        problems.len(),
        problems.join("\n")
    );
}

#[test]
fn repair_request_matches_the_js_layer() {
    use pdf_inspector::invoice::read::{read_invoice, DEFAULT_ALTERNATIVES};
    use pdf_inspector::invoice::repair::{repair_request, RequestOptions};
    let mut checked = 0;
    for (pdf, name) in CORPUS {
        let expected = &golden(name)["repair"];
        if expected.is_null() {
            continue;
        }
        let read = read_invoice(&bytes(pdf), "", &DEFAULT_ALTERNATIVES, None).unwrap();
        let req = repair_request(read.invoice.as_ref().unwrap(), &RequestOptions::default());
        assert_eq!(req.prompt, expected["prompt"].as_str().unwrap(), "{name}");
        let mut out = Vec::new();
        same(
            &serde_json::to_value(&req).unwrap(),
            expected,
            name,
            &mut out,
        );
        assert!(out.is_empty(), "{out:?}");
        checked += 1;
    }
    assert_eq!(checked, 1, "the misread fixture is repairable");
}

#[test]
fn apply_repair_keeps_a_fix_only_when_the_row_closes() {
    use pdf_inspector::invoice::read::{read_invoice, DEFAULT_ALTERNATIVES};
    use pdf_inspector::invoice::repair::{apply_repair, Status};
    let read = read_invoice(&bytes(CORPUS[4].0), "", &DEFAULT_ALTERNATIVES, None).unwrap();
    let invoice = read.invoice.unwrap();
    let wrong = serde_json::json!({ "fixes": [{ "row": 11, "quantity": 1, "unit_price": 37.35, "discount_pct": 0, "line_total": 37.35, "why": "guess" }] });
    let out = apply_repair(&invoice, &wrong, &[10], false);
    assert_eq!(out.status, Status::Repairable);
    let right = serde_json::json!({ "fixes": [{ "row": 11, "quantity": 1, "unit_price": 27.35, "discount_pct": 0, "line_total": 27.35, "why": "first digit read as 3" }] });
    let out = apply_repair(&invoice, &right, &[10], false);
    assert_eq!(out.status, Status::Ok, "{:?}", out.reasons);
    assert_eq!(out.applied.len(), 1);
    let outside = apply_repair(&invoice, &right, &[3], false);
    assert_eq!(outside.rejected.len(), 1);
}

#[test]
fn json_api_reads_repairs_and_exports() {
    use pdf_inspector::invoice::api::call;
    let read = call("read_invoice", "", &bytes(CORPUS[4].0));
    assert_eq!(read["ok"], true, "{read}");
    let result = &read["result"];
    assert_eq!(result["document"]["status"], "repairable");
    assert_eq!(
        result["document"]["repair"]["rows"],
        serde_json::json!((1..=15).collect::<Vec<_>>())
    );
    let state = result["state"].clone();

    let answer = |price: f64| serde_json::json!({ "fixes": [{ "row": 11, "quantity": 1, "unit_price": price, "discount_pct": 0, "line_total": price, "why": "first digit" }] });
    let wrong = call(
        "apply_repair",
        &serde_json::json!({ "state": state, "answer": answer(37.35) }).to_string(),
        &[],
    );
    assert_eq!(
        wrong["result"]["document"]["status"], "repairable",
        "{wrong}"
    );
    let right = call(
        "apply_repair",
        &serde_json::json!({ "state": state, "answer": answer(27.35) }).to_string(),
        &[],
    );
    let doc = &right["result"]["document"];
    assert_eq!(doc["status"], "ok", "{right}");
    assert_eq!(doc["repaired"], serde_json::json!([11]));
    assert_eq!(doc["lines"][10]["repaired"], "first digit");

    let csv = call(
        "invoice_csv",
        &serde_json::json!({ "state": right["result"]["state"] }).to_string(),
        &[],
    );
    let text = csv["result"]["csv"].as_str().unwrap();
    assert!(text.lines().nth(11).unwrap().contains(",27.35,"), "{text}");

    // The state survives a JSON round trip unchanged in what it reads.
    let again = call(
        "invoice_csv",
        &serde_json::json!({ "state": state }).to_string(),
        &[],
    );
    assert_eq!(
        again["result"]["csv"].as_str().unwrap().lines().count(),
        text.lines().count()
    );

    let scanned = call("process_pdf", r#"{"pages":[1]}"#, &bytes(CORPUS[1].0));
    assert_eq!(scanned["result"]["pdf_type"], "TextBased");
    assert!(scanned["result"]["markdown"]
        .as_str()
        .unwrap()
        .contains("<!-- Page 1 -->"));
}

/// Due date, supplier contact and bank on the corpus (anonymized values).
#[test]
fn details_of_the_corpus() {
    let expected = [
        (
            "print-to-pdf-5p",
            "2026-08-31",
            "שוטף",
            "20",
            "483",
            "064061",
            Some("378249449"),
        ),
        (
            "priority-1p",
            "2022-12-31",
            "ת23",
            "31",
            "034",
            "743847",
            None,
        ),
        (
            "priority-2p",
            "2022-11-30",
            "ת84",
            "31",
            "034",
            "760768",
            None,
        ),
        (
            "priority-4p",
            "2022-10-31",
            "ת54",
            "31",
            "034",
            "275261",
            None,
        ),
    ];
    for ((pdf, name), want) in CORPUS.iter().zip(expected) {
        assert_eq!(*name, want.0);
        let x = read(pdf);
        let d = parse_invoice_items(&x.markdown, &x.items)
            .details
            .unwrap_or_else(|| panic!("{name}: no details"));
        assert_eq!(d.due_date.as_deref(), Some(want.1), "{name}");
        assert_eq!(d.payment_terms.as_deref(), Some(want.2), "{name}");
        assert_eq!(
            (
                d.bank_code.as_deref(),
                d.bank_branch.as_deref(),
                d.bank_account.as_deref()
            ),
            (Some(want.3), Some(want.4), Some(want.5)),
            "{name}"
        );
        assert!(d.supplier_phone.is_some_and(|p| p.len() >= 9), "{name}");
        assert!(d.supplier_address.is_some(), "{name}");
        // 2026: printed under its label next to a 17-digit request id; the
        // 2022 invoices predate allocation numbers and print no label.
        assert_eq!(d.allocation_number.as_deref(), want.6, "{name}");
        assert!(
            d.allocation_candidates.is_empty() && d.allocation_context.is_none(),
            "{name}"
        );
    }
}

/// One call answers what an app needs: the first page, the page count, the
/// time it took; a document over the page limit is not read at all.
#[test]
fn read_invoice_call_says_more_and_stops_early() {
    use pdf_inspector::invoice::api::call;
    let bytes = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("he/fixtures/invoices/priority-4p.pdf"),
    )
    .unwrap();
    let out = call(
        "read_invoice",
        r#"{"first_page":true,"max_pages":40}"#,
        &bytes,
    );
    let r = &out["result"];
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(r["page_count"], 4);
    assert_eq!(r["engine"], env!("CARGO_PKG_VERSION"));
    assert!(r["read_ms"].is_u64());
    let first = r["first_page"].as_str().unwrap();
    assert!(first.starts_with("<!-- Page 1 -->") && !first.contains("<!-- Page 2 -->"));
    assert!(first.contains("עוסק מורשה"));
    assert_eq!(r["document"]["details"]["bank_code"], "31");
    assert_eq!(r["document"]["lines"].as_array().unwrap().len(), 129);

    let out = call("read_invoice", r#"{"max_pages":3}"#, &bytes);
    let r = &out["result"];
    assert_eq!(r["document"]["status"], "unreadable");
    assert!(r["document"]["reasons"][0]
        .as_str()
        .unwrap()
        .starts_with("too many pages (4"));
    assert_eq!(r["page_count"], 4);
    assert!(r["state"].is_null());
    // The limit counts the pages asked for.
    let out = call("read_invoice", r#"{"max_pages":3,"pages":[1,2]}"#, &bytes);
    let reasons = out["result"]["document"]["reasons"].to_string();
    assert!(!reasons.contains("too many pages"), "{reasons}");
    assert_eq!(
        out["result"]["document"]["pdf"]["pages"],
        serde_json::json!([1, 2])
    );
}
