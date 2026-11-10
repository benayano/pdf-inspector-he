//! What an accounts-payable system wants beyond the table and the totals:
//! when the invoice is due, how to reach and pay the supplier, and the tax
//! authority's allocation number. Read from the labelled fields around the
//! table and the text under it; a value that is not printed is `None`,
//! never guessed.
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::model::{Block, Field, Header};
use super::records::iso_date;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Details {
    /// ISO date printed as "לתשלום עד" / "תאריך פרעון"; terms alone give none.
    pub due_date: Option<String>,
    /// As printed: "שוטף + 30", "ת84".
    pub payment_terms: Option<String>,
    pub supplier_phone: Option<String>,
    /// The lines between the supplier's name and its first labelled field.
    pub supplier_address: Option<String>,
    /// The bank's number ("31"), digits only. All three bank values or none.
    pub bank_code: Option<String>,
    pub bank_branch: Option<String>,
    pub bank_account: Option<String>,
    /// מספר הקצאה (9 digits or more), digits only.
    pub allocation_number: Option<String>,
}

impl Details {
    pub fn is_empty(&self) -> bool {
        *self == Details::default()
    }
}

static TAX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)עוסק מורשה|^ח\.?\s?פ\.?$|^ע\.?\s?מ\.?$|^vat (no|number)|^tax id").unwrap()
});
static DUE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)לתשלום עד|תאריך פי?רעון|מועד ה?תשלום|תאריך ה?תשלום|due date").unwrap()
});
static TERMS: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)תנאי ה?תשלום|payment terms").unwrap());
static PHONE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(טלפון|טל\.?|טל'|נייד|tel\.?|phone)$").unwrap());
static PHONE_VALUE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[+*]?[0-9][0-9 \-]{5,16}").unwrap());
static ALLOCATION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)מספר ה?הקצאה|מס['.]? ה?הקצאה|allocation").unwrap());
static TRANSFER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)להעברה|פרטי ה?בנק|פרטי ה?חשבון|bank details").unwrap());
static BANK: Lazy<Regex> = Lazy::new(|| Regex::new(r"בנק[^()\n]{0,60}\(([0-9]{1,2})\)").unwrap());
static BRANCH: Lazy<Regex> = Lazy::new(|| Regex::new(r"סניף[^0-9\n]{0,6}([0-9]{1,4})").unwrap());
static ACCOUNT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"חשבון[^0-9\n]{0,6}([0-9][0-9\-/]{3,14})").unwrap());

fn digits(text: &str) -> String {
    text.chars().filter(char::is_ascii_digit).collect()
}

/// Bank number, branch and account printed after "להעברה" / "פרטי בנק", in
/// that order on the page; all three or nothing.
pub fn bank_details(text: &str) -> Option<(String, String, String)> {
    let from = TRANSFER.find(text)?.start();
    let tail: String = text[from..].chars().take(400).collect();
    let bank = BANK.captures(&tail)?;
    let after_bank = &tail[bank.get(0)?.end()..];
    let branch = BRANCH.captures(after_bank)?;
    let after_branch = &after_bank[branch.get(0)?.end()..];
    let account = digits(&ACCOUNT.captures(after_branch)?[1]);
    (account.len() >= 4).then(|| (bank[1].to_string(), branch[1].to_string(), account))
}

fn supplier_block(header: &Header) -> Option<&Block> {
    let tax = header
        .fields
        .iter()
        .find(|f| TAX.is_match(&f.label) && !f.value.is_empty())?;
    header.blocks.iter().find(|b| b.fields.contains(tax))
}

fn address_of(block: &Block) -> Option<String> {
    let lines: Vec<&str> = block
        .lines
        .iter()
        .skip(1)
        .map(|l| l.trim())
        .take_while(|l| !l.contains(':'))
        .filter(|l| !l.is_empty())
        .collect();
    (!lines.is_empty()).then(|| lines.join(", "))
}

/// `footer_fields` and `footer_text` are what stands under the item table.
pub fn details_from(header: &Header, footer_fields: &[Field], footer_text: &str) -> Details {
    let fields = || header.fields.iter().chain(footer_fields.iter());
    let value_of = |re: &Regex| {
        fields()
            .find(|f| re.is_match(&f.label) && !f.value.trim().is_empty())
            .map(|f| f.value.trim().to_string())
    };
    let supplier = supplier_block(header);
    let bank = bank_details(footer_text);
    Details {
        due_date: fields()
            .filter(|f| DUE.is_match(&f.label))
            .find_map(|f| iso_date(&f.value)),
        payment_terms: value_of(&TERMS),
        supplier_phone: supplier.and_then(|b| {
            b.fields
                .iter()
                .filter(|f| PHONE.is_match(f.label.trim()))
                .find_map(|f| PHONE_VALUE.find(f.value.trim()))
                .map(|m| m.as_str().trim().to_string())
        }),
        supplier_address: supplier.and_then(address_of),
        bank_code: bank.as_ref().map(|b| b.0.clone()),
        bank_branch: bank.as_ref().map(|b| b.1.clone()),
        bank_account: bank.as_ref().map(|b| b.2.clone()),
        allocation_number: fields()
            .filter(|f| ALLOCATION.is_match(&f.label))
            .map(|f| f.value.trim())
            .find(|v| v.len() >= 9 && v.chars().all(|c| c.is_ascii_digit()))
            .map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bank_details_need_the_anchor_and_all_three_values() {
        assert_eq!(
            bank_details("פרטי בנק להעברה: בנק הפועלים (12), סניף 034 חשבון 760768 ע\"ש החברה"),
            Some(("12".into(), "034".into(), "760768".into()))
        );
        assert_eq!(
            bank_details(
                "פרטי חשבון להעברה: שם המוטב - חברה בנק - מזרחי (20) סניף - 483 מס' חשבון- 064-061"
            ),
            Some(("20".into(), "483".into(), "064061".into()))
        );
        // A shop's own branch, no transfer details.
        assert_eq!(bank_details("סניף: סניף צפון"), None);
        assert_eq!(bank_details("להעברה: בנק לאומי (10) סניף 800"), None);
        assert_eq!(bank_details("בנק לאומי (10) סניף 800 חשבון 123456"), None);
    }

    fn field(label: &str, value: &str) -> Field {
        Field {
            label: label.into(),
            value: value.into(),
            page: 1,
            y: 0.0,
        }
    }

    #[test]
    fn fields_give_dates_terms_supplier_and_allocation() {
        let tax = field("עוסק מורשה", "123456782");
        let phone = field("טלפון", "03-5551234 , פקס");
        let header = Header {
            blocks: vec![
                Block {
                    page: 1,
                    top: 0.0,
                    left: 0.0,
                    right: 0.0,
                    lines: vec![
                        "חומרי בניין בע\"מ".into(),
                        "הרחוב 5".into(),
                        "העיר 12345".into(),
                        "טלפון: 03-5551234".into(),
                    ],
                    text: String::new(),
                    fields: vec![phone.clone(), tax.clone()],
                },
                Block {
                    page: 1,
                    top: 0.0,
                    left: 0.0,
                    right: 0.0,
                    lines: vec!["לכבוד:".into()],
                    text: String::new(),
                    fields: vec![field("טלפון", "050-0000000")],
                },
            ],
            fields: vec![phone, tax, field("טלפון", "050-0000000")],
        };
        let footer = [
            field("תנאי תשלום", "שוטף + 30"),
            field("לתשלום עד", "30/11/22"),
            field("מספר הקצאה", "123456789"),
        ];
        let d = details_from(&header, &footer, "");
        assert_eq!(d.due_date.as_deref(), Some("2022-11-30"));
        assert_eq!(d.payment_terms.as_deref(), Some("שוטף + 30"));
        assert_eq!(d.supplier_phone.as_deref(), Some("03-5551234"));
        assert_eq!(d.supplier_address.as_deref(), Some("הרחוב 5, העיר 12345"));
        assert_eq!(d.allocation_number.as_deref(), Some("123456789"));
        assert_eq!(d.bank_code, None);
        // Terms are not a date; a short number is not an allocation number.
        let d = details_from(
            &Header::default(),
            &[field("לתשלום עד", "שוטף"), field("מספר הקצאה", "12")],
            "",
        );
        assert!(d.is_empty());
    }
}
