//! The item table: Markdown tables, merged across pages, each column given a
//! role and each row checked (quantity × price = total).
use once_cell::sync::Lazy;
use regex::Regex;

use super::amount::parse_amount;
use super::js::{js_number, js_sort_by, round2};
use super::model::{Column, LineCheck, Lines, Role, Row, Values};

/// A Markdown table as printed: its header and rows, the page it starts on.
#[derive(Debug, Clone)]
pub struct MarkdownTable {
    pub page: u32,
    pub header: Vec<String>,
    pub rows: Vec<(u32, Vec<String>)>,
}

/// Tables merged across pages.
#[derive(Debug, Clone)]
pub struct MergedTable {
    pub header: Vec<String>,
    pub rows: Vec<(u32, Vec<String>)>,
    pub pages: Vec<u32>,
}

static PAGE_MARK: Lazy<Regex> = Lazy::new(|| Regex::new(r"^<!-- Page ([0-9]+) -->").unwrap());
static SEPARATOR: Lazy<Regex> = Lazy::new(|| Regex::new(r"^:?-{3,}:?$").unwrap());

fn split_row(line: &str) -> Vec<String> {
    let cells: Vec<&str> = line.split('|').collect();
    if cells.len() < 2 {
        return Vec::new();
    }
    cells[1..cells.len() - 1]
        .iter()
        .map(|c| c.trim().to_string())
        .collect()
}

/// Every Markdown table, with the page it is on.
pub fn markdown_tables(markdown: &str) -> Vec<MarkdownTable> {
    let mut tables: Vec<MarkdownTable> = Vec::new();
    let mut page = 1u32;
    let mut open = false;
    for line in markdown.split('\n') {
        if let Some(m) = PAGE_MARK.captures(line) {
            page = m[1].parse().unwrap_or(page);
        }
        if !line.starts_with('|') {
            open = false;
            continue;
        }
        let cells = split_row(line);
        if cells.iter().all(|c| SEPARATOR.is_match(c)) {
            continue;
        }
        if !open {
            tables.push(MarkdownTable {
                page,
                header: cells,
                rows: Vec::new(),
            });
            open = true;
        } else if let Some(t) = tables.last_mut() {
            t.rows.push((page, cells));
        }
    }
    tables
}

/// Joins tables that continue one another: same header, and (when the first
/// column numbers the rows) numbering that carries on rather than restarting.
pub fn merge_tables(tables: Vec<MarkdownTable>) -> Vec<MergedTable> {
    let mut merged: Vec<MergedTable> = Vec::new();
    let number = |cells: Option<&Vec<String>>| {
        cells
            .and_then(|c| c.first())
            .map_or(f64::NAN, |c| js_number(c))
    };
    for table in tables {
        let first = number(table.rows.first().map(|r| &r.1));
        let joins = merged.last().is_some_and(|last| {
            let last_n = number(last.rows.last().map(|r| &r.1));
            let restarts = first.fract() == 0.0
                && first.is_finite()
                && last_n.fract() == 0.0
                && last_n.is_finite()
                && first <= last_n;
            last.header == table.header && !restarts
        });
        if joins {
            let last = merged.last_mut().expect("checked");
            last.rows.extend(table.rows);
            last.pages.push(table.page);
        } else {
            merged.push(MergedTable {
                header: table.header,
                rows: table.rows,
                pages: vec![table.page],
            });
        }
    }
    merged
}

fn ci(pattern: &str) -> Regex {
    Regex::new(&format!("(?i){pattern}")).unwrap()
}

static ROLE_PATTERNS: Lazy<Vec<(Role, Regex)>> = Lazy::new(|| {
    vec![
        (Role::DeliveryNote, ci(r"^תעודה$|תעודת משלוח|delivery note")),
        (Role::Order, ci(r"^הזמנה$|^order$|purchase order")),
        (
            Role::NetUnitPrice,
            ci(r"(מחיר|price).*(אחרי|after|נטו|net)"),
        ),
        (
            Role::UnitPrice,
            ci(r"מחיר ל?יח|מחיר יחידה|unit price|^price$"),
        ),
        (Role::Discount, ci(r"הנחה|discount")),
        (Role::Quantity, ci(r"כמות|qty|quantity")),
        (Role::Total, ci(r#"סה"כ|סה״כ|סכום|total|amount"#)),
        // A printed site / project column ("תאור אתר") must win over the
        // description pattern, which also matches "תאור".
        (Role::Site, ci(r"אתר|פרויקט|^site(?-u:\b)|project")),
        (Role::Description, ci(r"תאור|תיאור|description|פריט|item")),
        (Role::Sku, ci(r#"מק"ט|מק״ט|sku|catalog"#)),
        (Role::Date, ci(r"תאריך|date")),
    ]
});
static INDEX_HEADER: Lazy<Regex> = Lazy::new(|| ci(r"^(|#|ש\.|מס'?|no\.?)$"));
static DIGITS: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9]+$").unwrap());

fn column_roles(header: &[String]) -> Vec<Option<Role>> {
    let mut roles: Vec<Option<Role>> = header
        .iter()
        .map(|name| {
            ROLE_PATTERNS
                .iter()
                .find(|(_, p)| p.is_match(name))
                .map(|(r, _)| *r)
        })
        .collect();
    // The row-number column: unnamed, or "#"/"ש."/"מס'".
    if let (Some(None), Some(h)) = (roles.first(), header.first()) {
        if INDEX_HEADER.is_match(h) {
            roles[0] = Some(Role::Index);
        }
    }
    roles
}

/// quantity × price = line total, allowing the rounding the price and a
/// weighed quantity carry (0.67 kg is often ⅔ kg).
pub fn check_line(values: &Values) -> Option<LineCheck> {
    let (quantity, total) = (values.quantity?, values.total?);
    let price = values
        .net_unit_price
        .or(values.unit_price)
        .unwrap_or(0.0)
        .abs();
    let tolerance = 0.011 + quantity.abs() * 0.005 + price * 0.005;
    let mut candidates = Vec::new();
    if let Some(unit_price) = values.unit_price {
        let pct = values.discount.unwrap_or(0.0);
        candidates.push(quantity * unit_price * (1.0 - pct / 100.0));
    }
    if let Some(net) = values.net_unit_price {
        candidates.push(quantity * net);
    }
    let mut best = *candidates.first()?;
    for c in &candidates[1..] {
        if (c - total).abs() < (best - total).abs() {
            best = *c;
        }
    }
    Some(LineCheck {
        ok: (total - best).abs() <= tolerance,
        expected: round2(best),
        diff: round2(total - best),
    })
}

const NUMERIC: [Role; 5] = [
    Role::Quantity,
    Role::UnitPrice,
    Role::NetUnitPrice,
    Role::Discount,
    Role::Total,
];

fn set_text(values: &mut Values, role: Role, cell: &str) {
    let slot = match role {
        Role::Description => &mut values.description,
        Role::Sku => &mut values.sku,
        Role::Date => &mut values.date,
        Role::DeliveryNote => &mut values.delivery_note,
        Role::Order => &mut values.order,
        Role::Site => &mut values.site,
        // A number column whose cell is not an amount, or an index that is
        // not digits, is left empty (the JS layer stored the text there).
        _ => return,
    };
    if slot.as_deref().is_none_or(str::is_empty) {
        *slot = Some(cell.to_string());
    }
}

/// The item table: the merged table with the most rows that has a total and a quantity column.
pub fn line_items(markdown: &str) -> Option<Lines> {
    let tables = merge_tables(markdown_tables(markdown));
    let mut scored: Vec<(MergedTable, Vec<Option<Role>>)> = tables
        .into_iter()
        .map(|t| {
            let roles = column_roles(&t.header);
            (t, roles)
        })
        .filter(|(_, roles)| {
            roles.contains(&Some(Role::Total)) && roles.contains(&Some(Role::Quantity))
        })
        .collect();
    if scored.is_empty() {
        return None;
    }
    js_sort_by(&mut scored, |a, b| {
        b.0.rows.len() as f64 - a.0.rows.len() as f64
    });
    let (table, roles) = scored.swap_remove(0);
    let total_at = roles.iter().rposition(|r| *r == Some(Role::Total));
    let columns: Vec<Column> = table
        .header
        .iter()
        .enumerate()
        .map(|(i, name)| Column {
            name: name.clone(),
            role: if roles[i] == Some(Role::Total) && Some(i) != total_at {
                None
            } else {
                roles[i]
            },
        })
        .collect();
    let rows = table
        .rows
        .into_iter()
        .map(|(page, cells)| {
            let mut values = Values::default();
            let amounts: Vec<_> = cells
                .iter()
                .enumerate()
                .map(|(i, cell)| {
                    let amount = parse_amount(cell);
                    let role = columns.get(i).and_then(|c| c.role);
                    match (role, &amount) {
                        (Some(r), Some(a)) if NUMERIC.contains(&r) => {
                            let v = Some(a.value);
                            match r {
                                Role::Quantity => {
                                    values.quantity = v;
                                    if a.unit.is_some() {
                                        values.unit = a.unit.clone();
                                    }
                                }
                                Role::UnitPrice => values.unit_price = v,
                                Role::NetUnitPrice => values.net_unit_price = v,
                                Role::Discount => values.discount = v,
                                _ => values.total = v,
                            }
                        }
                        (Some(Role::Index), _) if DIGITS.is_match(cell) => {
                            values.index = cell.parse().ok()
                        }
                        (Some(r), _) if !cell.is_empty() => set_text(&mut values, r, cell),
                        _ => {}
                    }
                    amount
                })
                .collect();
            let check = check_line(&values);
            Row {
                page,
                cells,
                amounts,
                values,
                check,
                repaired: None,
                inserted: false,
            }
        })
        .collect();
    Some(Lines {
        columns,
        rows,
        pages: table.pages,
    })
}
