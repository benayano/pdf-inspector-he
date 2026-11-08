import type { Assessment } from "./repair.d.ts";
import type { Invoice } from "./invoice.d.ts";

export const DOCUMENT_SCHEMA: "pdf-inspector-he/invoice-document@1";
export const LINE_FIELDS: string[];

/** One line of the document: line fields only, plus `repaired` (why) / `inserted` when a repair touched it. */
export interface DocumentLine {
  row: number;
  line_no: number | null;
  page: number | null;
  date: string | null;
  delivery_note: string | null;
  order_ref: string | null;
  sku: string | null;
  description: string | null;
  site_text: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  discount_pct: number | null;
  net_unit_price: number | null;
  line_total: number | null;
  currency: string | null;
  marker: boolean;
  is_return: boolean;
  check_ok: boolean | null;
  check_diff: number | null;
  repaired?: string | true;
  inserted?: true;
}

/** The whole invoice as JSON; the formal shape is invoice-document.schema.json. */
export interface InvoiceDocument {
  schema: "pdf-inspector-he/invoice-document@1";
  pdf: { type: string | null; pages: number[] };
  status: "ok" | "repairable" | "unreadable";
  reasons: string[];
  invoice: (import("./invoice.d.ts").InvoiceInfo) | null;
  header: { fields: { label: string; value: string }[]; blocks: { page: number; text: string }[] };
  totals: { label: string; role: string; value: number; percent: number | null; currency: string | null }[];
  columns: { name: string; role: string | null }[];
  lines: DocumentLine[];
  checks: { name: string; ok: boolean; expected?: number; actual?: number; diff?: number; label?: string; sign?: "minus" | "plus" }[];
  failed_rows: number[];
  auto_fixed: { row: number; tuning: string }[];
  repaired: number[];
  repair: { needs_pages: boolean; pages: number[]; rows: number[]; prompt: string; schema: Record<string, unknown> } | null;
  markdown?: string;
}

export function invoiceDocument(
  read: { pdfType?: string; invoice: Invoice | null; assessment?: Assessment; autoFixed?: { row: number; tuning: string }[] },
  options?: { markdown?: string; repairRequest?: boolean; context?: string },
): InvoiceDocument;
