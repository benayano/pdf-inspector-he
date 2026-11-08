//! Positioned text around the table: items grouped into rows, rows into
//! "label: value" fields, and the header split into side-by-side blocks.
use once_cell::sync::Lazy;
use regex::Regex;

use super::amount::parse_amount;
use super::js::js_sort_by;
use super::model::{Block, Field, PositionedItem};
use crate::types::TextItem;

/// An item as the layer reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub text: String,
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub font_size: f64,
}

/// Positions to 0.01 pt, as `pdf2md --items-json` prints them: the same
/// input whichever engine (native, wasm, FFI) produced the items.
fn hundredths(v: f32) -> f64 {
    format!("{v:.2}").parse().unwrap_or(v as f64)
}

fn is_upright(rotation: f64, width: f64, height: f64, font_size: f64) -> bool {
    let r = ((rotation % 360.0) + 360.0) % 360.0;
    if r > 45.0 && r < 315.0 {
        return false;
    }
    // A box much taller than its em and only an em wide is a vertical run.
    !(height > font_size * 3.0 && width <= font_size * 1.5)
}

/// Text items of the extractor -> the layer's items (text only, upright).
pub fn items_from_text_items(items: &[TextItem]) -> Vec<Item> {
    items
        .iter()
        .filter(|i| matches!(i.item_type, crate::types::ItemType::Text))
        .filter_map(|i| {
            let (x, y, width, height) = (
                hundredths(i.x),
                hundredths(i.y),
                hundredths(i.width),
                hundredths(i.height),
            );
            let font_size = hundredths(i.font_size);
            let rotation = hundredths(i.rotation);
            (!i.text.trim().is_empty() && is_upright(rotation, width, height, font_size)).then(
                || Item {
                    text: i.text.clone(),
                    page: i.page,
                    x,
                    y,
                    width,
                    font_size,
                },
            )
        })
        .collect()
}

/// Items given as JSON (wasm or CLI shape) -> the layer's items.
pub fn items_from_positioned(items: &[PositionedItem]) -> Vec<Item> {
    items
        .iter()
        .filter(|i| i.item_type.as_deref().is_none_or(|t| t == "text"))
        .filter_map(|i| {
            let font_size = i.font_size.unwrap_or(i.height);
            (!i.text.trim().is_empty() && is_upright(i.rotation, i.width, i.height, font_size))
                .then(|| Item {
                    text: i.text.clone(),
                    page: i.page,
                    x: i.x,
                    y: i.y,
                    width: i.width,
                    font_size,
                })
        })
        .collect()
}

pub struct ItemRow<'a> {
    pub items: Vec<&'a Item>,
}

/// A page's items grouped into rows by baseline, each row in reading order.
pub fn rows_of<'a>(items: &[&'a Item], rtl: bool) -> Vec<ItemRow<'a>> {
    let mut sorted: Vec<&Item> = items.to_vec();
    js_sort_by(&mut sorted, |a, b| b.y - a.y);
    let mut rows: Vec<(f64, Vec<&Item>)> = Vec::new();
    for item in sorted {
        match rows.last_mut() {
            Some((y, list)) if (*y - item.y).abs() <= (item.font_size * 0.35).max(2.0) => {
                list.push(item)
            }
            _ => rows.push((item.y, vec![item])),
        }
    }
    rows.into_iter()
        .map(|(_, mut list)| {
            js_sort_by(&mut list, |a, b| if rtl { b.x - a.x } else { a.x - b.x });
            ItemRow { items: list }
        })
        .collect()
}

static MIRRORED: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(\S+)\s+:([A-Za-z][A-Za-z0-9_ .-]*)$").unwrap());
static TRAILING_DIGITS: Lazy<Regex> = Lazy::new(|| Regex::new(r"[0-9]{1,2}$").unwrap());
static LEADING_TWO: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9]{2}").unwrap());
static LETTER: Lazy<Regex> = Lazy::new(|| Regex::new(r"\p{L}").unwrap());

/// "label: value"; also the mirrored "ori@x.com :Email" of a right-to-left
/// line; not a time ("21:01").
pub fn split_field(text: &str) -> Option<(String, String)> {
    let t = text.trim();
    if let Some(m) = MIRRORED.captures(t) {
        return Some((m[2].trim().to_string(), m[1].to_string()));
    }
    let at = t.find(':')?;
    if at == 0 {
        return None;
    }
    let label = t[..at].trim();
    let value = t[at + 1..].trim();
    if label.is_empty() || (TRAILING_DIGITS.is_match(label) && LEADING_TWO.is_match(value)) {
        return None;
    }
    Some((label.to_string(), value.to_string()))
}

/// Fields of one row: "label: value" in one item, or a label followed in
/// reading order by an amount.
pub fn fields_of_row(items: &[&Item]) -> Vec<Field> {
    let mut fields = Vec::new();
    let mut i = 0;
    while i < items.len() {
        let item = items[i];
        if let Some((label, value)) = split_field(&item.text) {
            if !value.is_empty() {
                fields.push(Field {
                    label,
                    value,
                    page: item.page,
                    y: item.y,
                });
            } else if let Some(next) = items.get(i + 1) {
                fields.push(Field {
                    label,
                    value: next.text.trim().to_string(),
                    page: item.page,
                    y: item.y,
                });
                i += 1;
            }
            i += 1;
            continue;
        }
        if let Some(next) = items.get(i + 1) {
            if parse_amount(&item.text).is_none()
                && LETTER.is_match(&item.text)
                && parse_amount(&next.text).is_some()
            {
                fields.push(Field {
                    label: item.text.trim().to_string(),
                    value: next.text.trim().to_string(),
                    page: item.page,
                    y: item.y,
                });
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    fields
}

/// The header's blocks: items chain into one block when their boxes overlap
/// horizontally on adjacent lines; two blocks side by side stay two.
pub fn header_blocks(items: &[&Item], rtl: bool) -> Vec<Block> {
    let n = items.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], i: usize) -> usize {
        if parent[i] == i {
            return i;
        }
        let root = find(parent, parent[i]);
        parent[i] = root;
        root
    }
    for i in 0..n {
        for j in i + 1..n {
            let (a, b) = (items[i], items[j]);
            let em = a.font_size.max(b.font_size);
            let dy = (a.y - b.y).abs();
            let overlap = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
            let same_line = dy <= em * 0.35 && overlap > -em * 1.5;
            let stacked = dy > em * 0.35 && dy <= em * 1.8 && overlap > -1.0;
            if same_line || stacked {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                parent[ri] = rj;
            }
        }
    }
    // Groups in the order their roots are first met.
    let mut order: Vec<usize> = Vec::new();
    let mut groups: std::collections::HashMap<usize, Vec<&Item>> = std::collections::HashMap::new();
    for (i, item) in items.iter().enumerate() {
        let root = find(&mut parent, i);
        if !groups.contains_key(&root) {
            order.push(root);
        }
        groups.entry(root).or_default().push(item);
    }
    let mut blocks: Vec<Block> = order
        .into_iter()
        .map(|root| {
            let group = &groups[&root];
            let rows = rows_of(group, rtl);
            let lines: Vec<String> = rows
                .iter()
                .map(|r| {
                    r.items
                        .iter()
                        .map(|i| i.text.trim())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect();
            let top = group
                .iter()
                .map(|i| i.y + i.font_size)
                .fold(f64::NEG_INFINITY, f64::max);
            let left = group.iter().map(|i| i.x).fold(f64::INFINITY, f64::min);
            let right = group
                .iter()
                .map(|i| i.x + i.width)
                .fold(f64::NEG_INFINITY, f64::max);
            let fields = rows.iter().flat_map(|r| fields_of_row(&r.items)).collect();
            Block {
                page: group[0].page,
                top,
                left,
                right,
                text: lines.join("\n"),
                lines,
                fields,
            }
        })
        .collect();
    // Reading order: top band first; within a band, from the reading edge.
    js_sort_by(&mut blocks, |a, b| {
        if (a.top - b.top).abs() > 12.0 {
            b.top - a.top
        } else if rtl {
            b.right - a.right
        } else {
            a.left - b.left
        }
    });
    blocks
}
