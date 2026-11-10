//! The invoice's data model. Serialized it is the same JSON the JS layer
//! produced (`he/fixtures/golden/`): camelCase where JS was, absent where JS
//! left a key out. Deserializable, so a caller (Dart over the C ABI, JS
//! over wasm) can hold an invoice and hand it back for a repair.
use serde::{Deserialize, Serialize};

/// A parsed amount: "1,210.10", "461.54-", "101.69 ש"ח", "60.80 מטר", "38.00%".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Amount {
    pub value: f64,
    pub unit: Option<String>,
    pub currency: Option<String>,
    pub percent: bool,
    pub raw: String,
}

/// What a column of the item table holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Index,
    DeliveryNote,
    Order,
    Site,
    Description,
    Sku,
    Date,
    Quantity,
    UnitPrice,
    NetUnitPrice,
    Discount,
    Total,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    pub role: Option<Role>,
}

/// A row's values by role, numbers parsed. Absent = not printed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Values {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sku: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub delivery_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub order: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub quantity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub unit_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub net_unit_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub discount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub total: Option<f64>,
}

/// quantity × price (less discount) against the printed total.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineCheck {
    pub ok: bool,
    /// The arithmetic, rounded to cents.
    pub expected: f64,
    /// Printed total minus expected.
    pub diff: f64,
}

/// A repair's note on a row: why, and the values it had before.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Repaired {
    pub why: String,
    pub from: Values,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Row {
    pub page: u32,
    pub cells: Vec<String>,
    #[serde(default)]
    pub amounts: Vec<Option<Amount>>,
    pub values: Values,
    pub check: Option<LineCheck>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub repaired: Option<Repaired>,
    #[serde(skip_serializing_if = "is_false", default)]
    pub inserted: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// The item table, merged across pages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lines {
    pub columns: Vec<Column>,
    pub rows: Vec<Row>,
    pub pages: Vec<u32>,
}

/// "label: value", where it stood.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub label: String,
    pub value: String,
    pub page: u32,
    pub y: f64,
}

/// A block above the table (the customer, the dates…), kept apart from its neighbours.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Block {
    pub page: u32,
    pub top: f64,
    pub left: f64,
    pub right: f64,
    pub lines: Vec<String>,
    pub text: String,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Header {
    pub blocks: Vec<Block>,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TotalRole {
    Balance,
    AfterDiscount,
    Discount,
    Vat,
    Subtotal,
    Total,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Total {
    pub label: String,
    pub value: f64,
    pub currency: Option<String>,
    pub percent: Option<f64>,
    pub role: TotalRole,
    pub page: u32,
}

/// A row that failed `line-arithmetic`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FailedRow {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub index: Option<f64>,
    pub page: u32,
    pub ok: bool,
    pub expected: f64,
    pub diff: f64,
}

/// One arithmetic check. `lines-sum`, `discount`, `vat`, `grand-total`
/// carry expected/actual/diff; `line-arithmetic` carries checked/failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expected: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub actual: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub diff: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sign: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub checked: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub failed: Option<Vec<FailedRow>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Footer {
    pub fields: Vec<Field>,
}

/// An invoice read from a PDF: what parse_invoice returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Invoice {
    pub rtl: bool,
    pub header: Header,
    pub lines: Option<Lines>,
    pub totals: Vec<Total>,
    pub footer: Footer,
    pub checks: Vec<Check>,
    /// Due date, the supplier's phone, address and bank, the allocation
    /// number: absent when none was printed (and in reads of older versions).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<super::details::Details>,
}

/// A positioned text run as the invoice layer reads it. Accepts both the
/// wasm shape (`fontSize`, `isBold`) and the CLI shape (`font_size`,
/// `is_bold`, `item_type`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PositionedItem {
    pub text: String,
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(alias = "fontSize", alias = "font_size", default)]
    pub font_size: Option<f64>,
    #[serde(alias = "isBold", alias = "is_bold", default)]
    pub bold: bool,
    #[serde(default)]
    pub rotation: f64,
    #[serde(alias = "itemType", alias = "item_type", default)]
    pub item_type: Option<String>,
}
