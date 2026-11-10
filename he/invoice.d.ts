/** An amount as printed: "1,210.10", "461.54-", "101.69 ש"ח", "38.00%". */
export interface Amount {
  value: number;
  /** The unit printed with it ("מטר", "יח'", 'ש"ח', "%"), or null. */
  unit: string | null;
  /** ISO code when the unit is a currency ("ILS", "USD", "EUR"). */
  currency: string | null;
  percent: boolean;
  raw: string;
}
export function parseAmount(text: string | null | undefined): Amount | null;

export interface Field {
  label: string;
  value: string;
  page?: number;
  y?: number;
}
export function splitField(text: string): { label: string; value: string } | null;

export interface MarkdownTable {
  page: number;
  header: string[];
  rows: { page: number; cells: string[] }[];
}
export function markdownTables(markdown: string): MarkdownTable[];
export function mergeTables(
  tables: MarkdownTable[],
): { header: string[]; rows: { page: number; cells: string[] }[]; pages: number[] }[];

export type ColumnRole =
  | "index"
  | "deliveryNote"
  | "order"
  | "site"
  | "description"
  | "sku"
  | "date"
  | "quantity"
  | "unitPrice"
  | "netUnitPrice"
  | "discount"
  | "total"
  | null;

export interface LineCheck {
  ok: boolean;
  /** quantity x price (less discount), rounded to cents. */
  expected: number;
  /** printed total minus expected. */
  diff: number;
}

export interface LineItem {
  page: number;
  cells: string[];
  amounts: (Amount | null)[];
  values: {
    index?: number;
    description?: string;
    sku?: string;
    date?: string;
    deliveryNote?: string;
    order?: string;
    /** A printed site / project column ("תאור אתר"). */
    site?: string;
    quantity?: number;
    unit?: string;
    unitPrice?: number;
    netUnitPrice?: number;
    discount?: number;
    total?: number;
  };
  check: LineCheck | null;
}

export interface LineItems {
  columns: { name: string; role: ColumnRole }[];
  rows: LineItem[];
  pages: number[];
}
export function lineItems(markdown: string): LineItems | null;

export interface HeaderBlock {
  page: number;
  top: number;
  left: number;
  right: number;
  lines: string[];
  text: string;
  fields: Field[];
}

export interface PositionedItem {
  text: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
  font_size?: number;
  rotation?: number;
}
export function headerBlocks(items: PositionedItem[], rtl: boolean): HeaderBlock[];

export type TotalRole = "subtotal" | "discount" | "afterDiscount" | "vat" | "total" | "balance";
export interface Total {
  label: string;
  value: number;
  currency: string | null;
  /** The rate printed in the label, "(18.00%)" -> 18. */
  percent: number | null;
  role: TotalRole;
  page: number;
}

export interface Check {
  name: "lines-sum" | "line-arithmetic" | "discount" | "vat" | "grand-total";
  ok: boolean;
  expected?: number;
  actual?: number;
  diff?: number;
  [extra: string]: unknown;
}

export interface Invoice {
  rtl: boolean;
  header: { blocks: HeaderBlock[]; fields: Field[] };
  lines: LineItems | null;
  totals: Total[];
  footer: { fields: Field[] };
  checks: Check[];
  /** From the Rust layer (engines with invoiceCall); absent when nothing was printed. */
  details?: InvoiceDetails;
}

/** What is printed around the table for whoever pays the invoice; null where not printed, never guessed. */
export interface InvoiceDetails {
  /** ISO date printed as "לתשלום עד" / "תאריך פרעון"; terms alone give none. */
  due_date: string | null;
  /** As printed: "שוטף + 30". */
  payment_terms: string | null;
  supplier_phone: string | null;
  /** The lines between the supplier's name and its first labelled field. */
  supplier_address: string | null;
  /** The bank's number, branch and account for transfers, digits only: all three or none. */
  bank_code: string | null;
  bank_branch: string | null;
  bank_account: string | null;
  /** מספר הקצאה, digits only: a labelled value, or the one nine-digit number by the label. */
  allocation_number: string | null;
  /**
   * The label is printed but the code could not decide (no nine-digit number by it, or several):
   * every number of 9+ digits on the label's line and the line under it. Ask a model to pick
   * ONE OF THESE, never to write a number. Absent when decided or when no label is printed.
   */
  allocation_candidates?: string[];
  /** The label's line and the line under it, as printed (for that question). */
  allocation_context?: string;
}

/**
 * @param input.markdown pdf2md / processPdf output (with page markers).
 * @param input.items    extractTextWithPositions / pdf2md --items-json output.
 */
export function parseInvoice(input: {
  markdown: string;
  items?: PositionedItem[] | { items: PositionedItem[] };
}): Invoice;

/** "31/08/26" or "31.08.2026" -> "2026-08-31"; anything else -> null. */
export function isoDate(text: string | null | undefined): string | null;

/** The invoice's own facts; null where not found (never guessed). */
export interface InvoiceInfo {
  /** "credit" when the header says זיכוי / credit note. */
  document_type: "invoice" | "credit";
  invoice_number: string | null;
  /** ISO date. */
  invoice_date: string | null;
  supplier_name: string | null;
  /** Digits only. */
  supplier_tax_id: string | null;
  subtotal: number | null;
  discount: number | null;
  after_discount: number | null;
  vat_rate: number | null;
  vat: number | null;
  total: number | null;
  currency: string | null;
  /** Every check that ran passed. */
  checks_ok: boolean;
}
export function invoiceInfo(invoice: Invoice): InvoiceInfo;

/** One flat record per item line; keys in the order of RECORD_COLUMNS. */
export interface LineRecord {
  invoice_number: string | null;
  invoice_date: string | null;
  supplier_name: string | null;
  supplier_tax_id: string | null;
  line_no: number;
  page: number;
  date: string | null;
  delivery_note: string | null;
  order_ref: string | null;
  sku: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  discount_pct: number | null;
  net_unit_price: number | null;
  line_total: number | null;
  currency: string | null;
  check_ok: boolean | null;
  check_diff: number | null;
  /** The printed site column's text, a hint (not an id). */
  site_text: string | null;
  /** A note line priced at a cent or less ("לקח …"), not goods. */
  marker: boolean;
  /** A negative line inside an ordinary invoice (goods returned). */
  is_return: boolean;
}
export const RECORD_COLUMNS: (keyof LineRecord)[];
export function toRecords(invoice: Invoice): LineRecord[];

export function checkLine(values: LineItem["values"]): LineCheck | null;
export function totalsChecks(lines: LineItems | null, totals: Total[]): Check[];
/** Row checks and totals checks computed again from the rows' values (after a repair). */
export function recheck(invoice: Invoice): Invoice;
export function isMarkerLine(values: LineItem["values"]): boolean;
export function documentType(invoice: Invoice): "invoice" | "credit";

/**
 * Defaults are for Excel (BOM, formula-like text prefixed with '). For a
 * database COPY pass { bom: false, excelSafe: false }.
 */
export function toCsv(
  records: object[],
  options?: { columns?: string[]; bom?: boolean; excelSafe?: boolean },
): string;
