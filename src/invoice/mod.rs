//! Invoices: the item table, header, totals and arithmetic checks, read from
//! the extractor's Markdown and positioned items; repair of rows that do not
//! close; one JSON document per invoice.
//!
//! First written in JavaScript (`he/invoice.mjs`, `he/repair.mjs`,
//! `he/document.mjs`); this is now the one implementation, behind every
//! binding (CLI `pdf2md --invoice-json`, wasm, the C ABI that Dart calls).
//! Its output on the corpus is held to the JS layer's, recorded in
//! `he/fixtures/golden/` (tests/invoice_golden.rs).
//!
//! Nothing here guesses silently: a check that cannot run is absent, a check
//! that fails says by how much.
pub mod amount;
pub mod api;
pub mod document;
mod js;
pub mod layout;
pub mod model;
pub mod read;
pub mod records;
pub mod repair;
pub mod table;
pub mod totals;

use std::collections::BTreeSet;

pub use amount::parse_amount;
pub use model::*;
pub use records::{
    document_type, invoice_info, is_marker_line, iso_date, to_csv, to_records, InvoiceInfo,
    LineRecord, RECORD_COLUMNS,
};
pub use table::{check_line, line_items};
pub use totals::{total_role, totals_checks};

use layout::{fields_of_row, header_blocks, rows_of, Item};

fn is_rtl_text(text: &str) -> bool {
    text.chars()
        .any(|c| ('\u{0590}'..='\u{05FF}').contains(&c) || ('\u{0600}'..='\u{06FF}').contains(&c))
}

/// Where the item table stands on a page: (top of its header, bottom of its last row).
fn table_span(items: &[Item], lines: &Lines, page: u32) -> (Option<f64>, Option<f64>) {
    let header: BTreeSet<&str> = lines
        .columns
        .iter()
        .map(|c| c.name.as_str())
        .filter(|n| !n.is_empty())
        .collect();
    let head: Vec<&Item> = items
        .iter()
        .filter(|i| i.page == page && header.contains(i.text.trim()))
        .collect();
    let bottom = lines
        .rows
        .iter()
        .rfind(|r| r.page == page)
        .and_then(|last| {
            let tail: BTreeSet<&str> = last
                .cells
                .iter()
                .map(String::as_str)
                .filter(|c| !c.is_empty())
                .collect();
            let hits: Vec<f64> = items
                .iter()
                .filter(|i| i.page == page && tail.contains(i.text.trim()))
                .map(|i| i.y)
                .collect();
            (!hits.is_empty()).then(|| hits.iter().copied().fold(f64::INFINITY, f64::min))
        });
    let top = (!head.is_empty()).then(|| {
        head.iter()
            .map(|i| i.y + i.font_size)
            .fold(f64::NEG_INFINITY, f64::max)
    });
    (top, bottom)
}

/// The invoice from the extractor's Markdown (with page markers) and its
/// positioned items. Without items: lines and row checks, no header or totals.
pub fn parse_invoice_items(markdown: &str, positioned: &[Item]) -> Invoice {
    let lines = line_items(markdown);
    let text: String = positioned.iter().map(|i| i.text.as_str()).collect();
    let rtl = is_rtl_text(if text.is_empty() { markdown } else { &text });
    let pages: BTreeSet<u32> = positioned.iter().map(|i| i.page).collect();
    let on = |page: u32| {
        positioned
            .iter()
            .filter(move |i| i.page == page)
            .collect::<Vec<&Item>>()
    };

    let mut header = Header::default();
    let mut total_fields: Vec<Field> = Vec::new();
    match &lines {
        Some(l) if !positioned.is_empty() => {
            let first_page = l.pages.first().copied().unwrap_or(1);
            let last_page = l.rows.iter().map(|r| r.page).max().unwrap_or(0);
            if let (Some(top), _) = table_span(positioned, l, first_page) {
                let above: Vec<&Item> = on(first_page).into_iter().filter(|i| i.y > top).collect();
                header.blocks = header_blocks(&above, rtl);
                header.fields = header
                    .blocks
                    .iter()
                    .flat_map(|b| b.fields.clone())
                    .collect();
            }
            if let (_, Some(bottom)) = table_span(positioned, l, last_page) {
                let below: Vec<&Item> = on(last_page)
                    .into_iter()
                    .filter(|i| i.y < bottom - 1.0)
                    .collect();
                total_fields = rows_of(&below, rtl)
                    .iter()
                    .flat_map(|r| fields_of_row(&r.items))
                    .collect();
            }
            // A table that fills its page leaves the totals box for the next one,
            // under that page's repeated header: read it from its first totals row.
            for &page in pages.iter().filter(|&&p| p > last_page) {
                let items = on(page);
                let rows = rows_of(&items, rtl);
                let start = rows.iter().position(|r| {
                    fields_of_row(&r.items)
                        .iter()
                        .any(|f| total_role(&f.label).is_some())
                });
                if let Some(start) = start {
                    total_fields.extend(rows[start..].iter().flat_map(|r| fields_of_row(&r.items)));
                }
            }
        }
        None => {
            for &page in &pages {
                header.blocks.extend(header_blocks(&on(page), rtl));
            }
            header.fields = header
                .blocks
                .iter()
                .flat_map(|b| b.fields.clone())
                .collect();
        }
        _ => {}
    }
    let totals = totals::totals_from(&total_fields);
    let checks = totals_checks(lines.as_ref(), &totals);
    Invoice {
        rtl,
        header,
        lines,
        totals,
        footer: Footer {
            fields: total_fields,
        },
        checks,
    }
}

/// [`parse_invoice_items`] with items as JSON gives them (wasm or CLI shape).
pub fn parse_invoice(markdown: &str, items: &[PositionedItem]) -> Invoice {
    parse_invoice_items(markdown, &layout::items_from_positioned(items))
}

/// Row checks and totals checks computed again from the rows' values (after a repair).
pub fn recheck(invoice: &Invoice) -> Invoice {
    let mut out = invoice.clone();
    if let Some(lines) = &mut out.lines {
        for row in &mut lines.rows {
            row.check = check_line(&row.values);
        }
    }
    out.checks = totals_checks(out.lines.as_ref(), &out.totals);
    out
}
