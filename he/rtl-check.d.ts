export interface PositionedItem {
  text: string;
  page: number;
  x: number;
  y: number;
  width?: number;
}

export interface Row {
  page: number;
  y: number;
  text: string;
  cells: string[];
}

export interface AmbiguousRow {
  page: number;
  y: number;
  /** Row text keyed by the candidate gap that produced it. */
  readings: Record<string, string>;
}

export type Extract = (
  data: Uint8Array,
  options: { numberGap: number },
) => PositionedItem[] | Promise<PositionedItem[]>;

/** Caller-supplied LLM call: prompt in, model text out. */
export type Ask = (prompt: string) => Promise<string>;

export interface GapChoice {
  /** The chosen gap, or null to keep the default. */
  gap: number | null;
  reason: "no-ambiguous-rows" | "llm-undecided" | "low-agreement" | "llm-majority";
  agreement?: number;
  votes: Record<string, number>;
  decisions: { page: number; y: number; text: string }[];
}

export const DEFAULT_CANDIDATES: number[];

export function rowsOf(items: PositionedItem[], options?: { tolerance?: number }): Row[];

export function findAmbiguousRows(
  extract: Extract,
  data: Uint8Array,
  options?: { candidates?: number[]; tolerance?: number },
): Promise<{ candidates: number[]; ambiguous: AmbiguousRow[]; rowsChecked: number }>;

export function buildPrompt(rows: AmbiguousRow[], options?: { context?: string }): string;

export function chooseNumberGap(
  found: { candidates: number[]; ambiguous: AmbiguousRow[] },
  ask: Ask,
  options?: { sample?: number; context?: string; minAgreement?: number },
): Promise<GapChoice>;

export function extractWithLlmCheck(
  extract: Extract,
  data: Uint8Array,
  ask: Ask,
  options?: {
    candidates?: number[];
    sample?: number;
    context?: string;
    fallbackGap?: number;
    minAgreement?: number;
    tolerance?: number;
  },
): Promise<{
  numberGap: number;
  items: PositionedItem[];
  rows: Row[];
  check: GapChoice & { ambiguousRows: number; rowsChecked: number };
}>;

export interface KnobDescription {
  name: string;
  unit: string;
  auto: string;
  effect: string;
}

export type RunText = (
  data: Uint8Array,
  options: { tuning: string },
) => string | Promise<string>;

export interface TuningComparison {
  candidates: string[];
  outputs: string[];
  /** Per candidate: lines no other candidate produced (capped). */
  unique: string[][];
  identical: boolean;
}

export function compareTunings(
  run: RunText,
  data: Uint8Array,
  candidates: string[],
  options?: { maxLines?: number },
): Promise<TuningComparison>;

export function buildTuningPrompt(compared: TuningComparison, options?: { context?: string }): string;

export function chooseTuning(
  run: RunText,
  data: Uint8Array,
  ask: Ask,
  options: { candidates: string[]; context?: string; maxLines?: number },
): Promise<{
  tuning: string | null;
  reason: "identical-outputs" | "llm-undecided" | "llm-choice";
  why?: string;
  output?: string;
  compared: TuningComparison;
}>;

/** An Anthropic tool definition for an agent that calls the extractor itself. */
export function extractionToolDefinition(knobs: KnobDescription[]): {
  name: "extract_pdf";
  description: string;
  input_schema: object;
};
