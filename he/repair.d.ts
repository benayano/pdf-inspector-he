import type { Check, Invoice } from "./invoice.js";

export interface Assessment {
  /** ok: every check passed. repairable: a few rows or a total fail. unreadable: no table / no totals / read wrong as a whole. */
  status: "ok" | "repairable" | "unreadable";
  reasons: string[];
  /** Indexes into invoice.lines.rows. */
  failedRows: number[];
  /** Failed checks other than line-arithmetic. */
  failedChecks: Check[];
  /** A row is missing or extra: the model must see the pages, text alone cannot fix it. */
  needsPages: boolean;
  /** Pages the failing rows are on (all table pages when a row is missing). */
  pages: number[];
}
export function assess(invoice: Invoice, options?: { maxFailedShare?: number }): Assessment;

/** Fix failing rows from other readings of the same PDF, with no model. `from` is the alternative's index. */
export function autoRepair(
  invoice: Invoice,
  alternatives: Invoice[],
): { invoice: Invoice; fixed: { row: number; from: number }[] };

export const REPAIR_COLUMNS: string[];
/** The rows (indexes) as compact CSV; `row` (1-based) is the id the answer uses. */
export function slimCsv(invoice: Invoice, rowIndexes: number[], options?: { columns?: string[] }): string;

/** JSON schema of the model's answer. */
export const REPAIR_SCHEMA: Record<string, unknown>;

export interface RepairAnswer {
  fixes: { row: number; quantity: number; unit_price: number; discount_pct: number; line_total: number; why: string }[];
  inserts: {
    after_row: number;
    line_no: number;
    delivery_note: string;
    sku: string;
    description: string;
    quantity: number;
    unit: string;
    unit_price: number;
    discount_pct: number;
    line_total: number;
  }[];
  unreadable: number[];
  notes: string;
}

export interface RepairRequest {
  status: Assessment["status"];
  prompt: string;
  schema: Record<string, unknown>;
  /** Row indexes sent. */
  rows: number[];
  pages: number[];
  /** Attach these pages (as PDF or images) to the request. */
  needsPages: boolean;
}
export function repairRequest(
  invoice: Invoice,
  options?: { context?: string; neighbours?: number; maxRows?: number; allRowsUpTo?: number },
): RepairRequest;

export function applyRepair(
  invoice: Invoice,
  answer: RepairAnswer,
  request: Pick<RepairRequest, "rows" | "needsPages">,
): {
  invoice: Invoice;
  applied: ({ row: number; why: string } | { inserted_after: number; description: string })[];
  rejected: (Record<string, unknown> & { reason: string })[];
  status: Assessment["status"];
  reasons: string[];
};

export const DEFAULT_ALTERNATIVES: string[];

export interface PdfModule {
  processPdf(bytes: Uint8Array, options?: Record<string, unknown>): { pdfType: string; markdown: string };
  extractTextWithPositions(bytes: Uint8Array, options?: Record<string, unknown>): unknown[];
}
/** Extract, parse and auto-repair in one call. */
export function readInvoice(
  pdf: PdfModule,
  bytes: Uint8Array,
  options?: { tuning?: string; alternatives?: string[]; pages?: number[] },
): { pdfType: string; invoice: Invoice | null; assessment: Assessment; autoFixed: { row: number; tuning: string }[] };
