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
}

/**
 * @param input.markdown pdf2md / processPdf output (with page markers).
 * @param input.items    extractTextWithPositions / pdf2md --items-json output.
 */
export function parseInvoice(input: {
  markdown: string;
  items?: PositionedItem[] | { items: PositionedItem[] };
}): Invoice;
