//! From PDF bytes to an invoice: the extraction the invoice layer reads.
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
        // One pass: the Markdown and the items it was built from.
        let (result, items) = crate::process_pdf_mem_with_items(bytes, options)?;
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

/// How [`read_invoice_with`] reads.
#[derive(Debug, Clone, Default)]
pub struct ReadOptions<'a> {
    /// `knob=value,...`.
    pub tuning: &'a str,
    /// Other readings tried on the pages of failing rows; `None`: [`DEFAULT_ALTERNATIVES`].
    pub alternatives: Option<&'a [&'a str]>,
    /// 1-based pages, or the whole document.
    pub pages: Option<&'a [u32]>,
    /// More pages than this (of those selected) are not read at all: the
    /// answer is `unreadable` in a millisecond or two instead of seconds.
    pub max_pages: Option<u32>,
}

fn unreadable(
    pdf_type: &str,
    page_count: u32,
    reason: String,
    markdown: Option<String>,
) -> InvoiceRead {
    InvoiceRead {
        assessment: Some(Assessment {
            status: Status::Unreadable,
            reasons: vec![reason],
            failed_rows: vec![],
            failed_checks: vec![],
            needs_pages: true,
            pages: vec![],
        }),
        pdf_type: Some(pdf_type.to_string()),
        invoice: None,
        auto_fixed: vec![],
        markdown,
        page_count,
        read_ms: None,
    }
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
    read_invoice_with(
        bytes,
        &ReadOptions {
            tuning,
            alternatives: Some(alternatives),
            pages,
            max_pages: None,
        },
    )
}

/// [`read_invoice`] with every option. The document is classified first
/// (a millisecond or two): a scan, or one longer than `max_pages`, is
/// answered without extracting anything.
pub fn read_invoice_with(bytes: &[u8], options: &ReadOptions) -> Result<InvoiceRead, PdfError> {
    let timer = crate::ProcessingTimer::start();
    let mut read = read_untimed(bytes, options)?;
    read.read_ms = (!cfg!(target_arch = "wasm32")).then(|| timer.elapsed_ms());
    Ok(read)
}

fn read_untimed(bytes: &[u8], options: &ReadOptions) -> Result<InvoiceRead, PdfError> {
    let (tuning, pages) = (options.tuning, options.pages);
    let alternatives = options.alternatives.unwrap_or(&DEFAULT_ALTERNATIVES);
    let parse_tuning = |t: &str| Tuning::parse(t).map_err(PdfError::Parse);
    let base_tuning = parse_tuning(tuning)?;
    let kind = crate::classify_pdf_mem(bytes)?;
    let kind_name = pdf_type_name(kind.pdf_type);
    if !matches!(kind.pdf_type, PdfType::TextBased | PdfType::Mixed) {
        return Ok(unreadable(
            kind_name,
            kind.page_count,
            format!("no text layer ({kind_name})"),
            None,
        ));
    }
    let selected = pages.map_or(kind.page_count, |p| {
        p.iter()
            .filter(|&&n| n >= 1 && n <= kind.page_count)
            .count() as u32
    });
    if let Some(max) = options.max_pages.filter(|&max| selected > max) {
        return Ok(unreadable(
            kind_name,
            kind.page_count,
            format!("too many pages ({selected}, the limit asked for is {max})"),
            None,
        ));
    }
    let x = extract(bytes, base_tuning, pages)?;
    let pdf_type = pdf_type_name(x.pdf_type).to_string();
    if !matches!(x.pdf_type, PdfType::TextBased | PdfType::Mixed) {
        return Ok(unreadable(
            &pdf_type,
            x.page_count,
            format!("no text layer ({pdf_type})"),
            Some(x.markdown),
        ));
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
        page_count: x.page_count,
        read_ms: None,
    })
}
