//! From PDF bytes to an invoice: the extraction the invoice layer reads.
use std::collections::HashSet;

use crate::detector::PdfType;
use crate::tuning::{with_tuning, Tuning};
use crate::{PdfError, PdfOptions};

use super::document::{AutoFix, InvoiceRead};
use super::layout::{items_from_text_items, Item};
use super::model::Invoice;
use super::parse_invoice_items;
use super::repair::{assess, auto_repair, Assessment, Status};

/// What one extraction pass gives the invoice layer.
#[derive(Debug, Clone)]
pub struct Extracted {
    pub pdf_type: PdfType,
    pub page_count: u32,
    /// Markdown with `<!-- Page N -->` markers.
    pub markdown: String,
    /// Upright text items, positions to 0.01 pt.
    pub items: Vec<Item>,
}

/// The wasm spelling of a PDF type: TextBased / Scanned / Mixed / ImageBased.
pub fn pdf_type_name(t: PdfType) -> &'static str {
    match t {
        PdfType::TextBased => "TextBased",
        PdfType::Scanned => "Scanned",
        PdfType::ImageBased => "ImageBased",
        PdfType::Mixed => "Mixed",
    }
}

/// Markdown (with page markers) and positioned items of `bytes`, with the
/// knobs of `tuning`, for `pages` (1-based) or the whole document.
pub fn extract(bytes: &[u8], tuning: Tuning, pages: Option<&[u32]>) -> Result<Extracted, PdfError> {
    with_tuning(tuning, || {
        let mut options = PdfOptions::new();
        if let Some(pages) = pages {
            options = options.pages(pages.iter().copied());
        }
        options.markdown.include_page_numbers = true;
        let result = crate::process_pdf_mem_with_options(bytes, options)?;
        let filter: Option<HashSet<u32>> = pages.map(|p| p.iter().copied().collect());
        let items =
            crate::extractor::extract_text_with_positions_mem_pages(bytes, filter.as_ref())?;
        Ok(Extracted {
            pdf_type: result.pdf_type,
            page_count: result.page_count,
            markdown: result.markdown.unwrap_or_default(),
            items: items_from_text_items(&items),
        })
    })
}

/// The other readings tried on the pages of failing rows, in order.
pub const DEFAULT_ALTERNATIVES: [&str; 3] = ["number_gap=0.1", "number_gap=0.3", "number_gap=auto"];

fn join_tuning(a: &str, b: &str) -> String {
    [a, b]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(",")
}

/// The whole read in one call: extract, parse the invoice, and when rows fail
/// try the alternative readings (pages of failing rows only) with no model.
/// `tuning` is `knob=value,...`; `pages` 1-based, or the whole document.
pub fn read_invoice(
    bytes: &[u8],
    tuning: &str,
    alternatives: &[&str],
    pages: Option<&[u32]>,
) -> Result<InvoiceRead, PdfError> {
    let parse_tuning = |t: &str| Tuning::parse(t).map_err(PdfError::Parse);
    let x = extract(bytes, parse_tuning(tuning)?, pages)?;
    let pdf_type = pdf_type_name(x.pdf_type).to_string();
    if !matches!(x.pdf_type, PdfType::TextBased | PdfType::Mixed) {
        return Ok(InvoiceRead {
            assessment: Some(Assessment {
                status: Status::Unreadable,
                reasons: vec![format!("no text layer ({pdf_type})")],
                failed_rows: vec![],
                failed_checks: vec![],
                needs_pages: true,
                pages: vec![],
            }),
            pdf_type: Some(pdf_type),
            invoice: None,
            auto_fixed: vec![],
            markdown: Some(x.markdown),
        });
    }
    let mut invoice = parse_invoice_items(&x.markdown, &x.items);
    let mut assessment = assess(&invoice, 0.4);
    let mut auto_fixed = Vec::new();
    if assessment.status == Status::Repairable && !assessment.failed_rows.is_empty() {
        // Only the pages with failing rows are read again: each reading costs
        // a full parse of what it reads.
        let only: Option<Vec<u32>> = if assessment.pages.is_empty() {
            pages.map(<[u32]>::to_vec)
        } else {
            Some(assessment.pages.clone())
        };
        let mut others = Vec::new();
        for alt in alternatives {
            let t = join_tuning(tuning, alt);
            let r = extract(bytes, parse_tuning(&t)?, only.as_deref())?;
            others.push((t, parse_invoice_items(&r.markdown, &r.items)));
        }
        let invoices: Vec<Invoice> = others.iter().map(|(_, i)| i.clone()).collect();
        let (fixed_invoice, fixed) = auto_repair(&invoice, &invoices);
        if !fixed.is_empty() {
            invoice = fixed_invoice;
            auto_fixed = fixed
                .into_iter()
                .map(|(row, from)| AutoFix {
                    row,
                    tuning: others[from].0.clone(),
                })
                .collect();
            assessment = assess(&invoice, 0.4);
        }
    }
    Ok(InvoiceRead {
        pdf_type: Some(pdf_type),
        invoice: Some(invoice),
        assessment: Some(assessment),
        auto_fixed,
        markdown: Some(x.markdown),
    })
}
