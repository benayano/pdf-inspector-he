import type { PdfModule } from "./repair.d.ts";

/** An Anthropic tool definition. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
/** The same tool for MCP (tools/list). */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const INVOICE_AGENT_INSTRUCTIONS: string;
/** read_invoice, get_rows, fix_rows, extract_text, get_invoice_json, list_knobs (+ export_invoice). */
export function invoiceToolDefinitions(options?: { withExport?: boolean }): ToolDefinition[];
export function toMcpTools(tools: ToolDefinition[]): McpTool[];
/** "failed" | "all" | "5-12,20" -> 0-based row indexes. */
export function parseRows(spec: string | undefined, count: number, failed: number[]): number[];
/** A tool result as the text a model reads: CSV as is, everything else as compact JSON. */
export function resultText(result: unknown): string;

export interface InvoiceAgent {
  tools: ToolDefinition[];
  mcpTools: McpTool[];
  instructions: string;
  /** Never throws; an error comes back as { ok: false, result: { error } }. */
  call(name: string, input?: Record<string, unknown>): Promise<{ ok: boolean; result: any }>;
}

export function createInvoiceAgent(options: {
  engine: PdfModule & { listKnobs?: () => { name: string; unit: string; auto: string; effect: string }[] };
  readFile: (file: string) => Uint8Array | Promise<Uint8Array>;
  /** Returns where it wrote; without it export_invoice is not offered. */
  writeFile?: (out: string, text: string) => string | void | Promise<string | void>;
  context?: string;
}): InvoiceAgent;
