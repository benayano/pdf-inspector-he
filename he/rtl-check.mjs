// Partial check with an LLM, then apply to the whole document.
//
// The number gap (see src/tuning.rs) decides whether two numbers that meet
// on a right-to-left line are one number or two: "1.2 3" or "31.2". No
// single value suits every producer. This module:
//
//   1. extracts the document at a few candidate gaps,
//   2. keeps only the rows where the candidates disagree (usually few),
//   3. asks a caller-supplied LLM which reading of each such row is right,
//   4. picks the gap that the LLM's answers agree with most, and
//   5. the caller re-extracts the whole document with that gap.
//
// The module never calls an LLM or holds a key itself: `ask(prompt)` is
// the caller's (e.g. a Supabase Edge Function calling Claude with a key
// from Supabase secrets). It works with any engine that returns positioned
// items: the wasm package's `extractTextWithPositions`, the Node package's
// `extractTextWithPositions`, or items from Python.

/** Candidate gaps, in em, checked by default. */
export const DEFAULT_CANDIDATES = [0.1, 0.2, 0.3];

/**
 * Group positioned items into rows (same page, baselines within
 * `tolerance` points) and read each row right to left.
 *
 * @param {{text:string,page:number,x:number,y:number,width?:number}[]} items
 * @param {{tolerance?:number}} [options]
 * @returns {{page:number,y:number,text:string,cells:string[]}[]}
 */
export function rowsOf(items, { tolerance = 2 } = {}) {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y);
  const rows = [];
  for (const item of sorted) {
    const last = rows[rows.length - 1];
    if (last && last.page === item.page && Math.abs(last.y - item.y) <= tolerance) {
      last.items.push(item);
    } else {
      rows.push({ page: item.page, y: item.y, items: [item] });
    }
  }
  return rows.map(({ page, y, items: rowItems }) => {
    const cells = rowItems
      .sort((a, b) => b.x - a.x)
      .map((i) => i.text.trim())
      .filter(Boolean);
    return { page, y, cells, text: cells.join(" | ") };
  });
}

function rowKey(row) {
  return `${row.page}:${Math.round(row.y)}`;
}

/**
 * Extract at each candidate gap and return the rows whose reading depends
 * on the gap.
 *
 * @param {(data: Uint8Array, options: {numberGap:number}) => Promise<any[]>|any[]} extract
 * @param {Uint8Array} data
 * @param {{candidates?:number[], tolerance?:number}} [options]
 * @returns {Promise<{candidates:number[], ambiguous:{page:number,y:number,readings:Record<string,string>}[], rowsChecked:number}>}
 */
export async function findAmbiguousRows(extract, data, options = {}) {
  const candidates = options.candidates ?? DEFAULT_CANDIDATES;
  const byGap = [];
  for (const gap of candidates) {
    const items = await extract(data, { numberGap: gap });
    byGap.push(new Map(rowsOf(items, options).map((r) => [rowKey(r), r])));
  }
  const keys = new Set(byGap.flatMap((m) => [...m.keys()]));
  const ambiguous = [];
  for (const key of keys) {
    const readings = {};
    let first;
    for (let i = 0; i < candidates.length; i++) {
      const row = byGap[i].get(key);
      if (!row) continue;
      first ??= row;
      readings[String(candidates[i])] = row.text;
    }
    if (new Set(Object.values(readings)).size > 1) {
      ambiguous.push({ page: first.page, y: first.y, readings });
    }
  }
  ambiguous.sort((a, b) => a.page - b.page || b.y - a.y);
  return { candidates, ambiguous, rowsChecked: keys.size };
}

/**
 * The prompt for one batch of ambiguous rows. The LLM sees only the
 * distinct readings, labelled A, B, C…, never the gap values.
 *
 * @param {{page:number,readings:Record<string,string>}[]} rows
 * @param {{context?:string}} [options]
 */
export function buildPrompt(rows, { context } = {}) {
  const lines = rows.map((row, index) => {
    const distinct = [...new Set(Object.values(row.readings))];
    const options = distinct.map((text, k) => `  ${String.fromCharCode(65 + k)}: ${text}`);
    return `Row ${index + 1} (page ${row.page}):\n${options.join("\n")}`;
  });
  return [
    "Each row below is one table row of a Hebrew document (an invoice),",
    "read right to left, with cells separated by ' | '. The readings of a row",
    "differ only in how numbers next to each other were joined or ordered",
    '(e.g. "1.2 3" vs "31.2" vs "3 1.2"). Pick the reading a person sees on',
    "the printed page. Typical patterns: a length then a count (\"3.2 19 יח\"),",
    "dimensions (\"50*50 3.25\"), prices with two decimals.",
    "Where the row allows it, check the arithmetic between cells: a length",
    "times a count equals the quantity column (3.2 × 19 = 60.80).",
    context ? `\nContext: ${context}` : "",
    "",
    lines.join("\n\n"),
    "",
    'Answer with JSON only: {"answers":[{"row":1,"choice":"A"}, ...]}.',
    'Use "?" when you cannot tell.',
  ].join("\n");
}

function parseAnswers(reply) {
  const match = String(reply).match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed.answers) ? parsed.answers : [];
  } catch {
    return [];
  }
}

/**
 * Ask the LLM about a sample of the ambiguous rows and choose the gap the
 * answers support. Returns `gap: null` when nothing was ambiguous or the
 * LLM could not decide; the caller then keeps its default.
 *
 * @param {{candidates:number[], ambiguous:{page:number,y:number,readings:Record<string,string>}[]}} found
 * @param {(prompt: string) => Promise<string>} ask
 * @param {{sample?:number, context?:string, minAgreement?:number}} [options]
 */
export async function chooseNumberGap(found, ask, options = {}) {
  const { sample = 12, context, minAgreement = 0.6 } = options;
  const rows = found.ambiguous.slice(0, sample);
  if (rows.length === 0) {
    return { gap: null, reason: "no-ambiguous-rows", votes: {}, decisions: [] };
  }
  const reply = await ask(buildPrompt(rows, { context }));
  const answers = parseAnswers(reply);
  const votes = Object.fromEntries(found.candidates.map((g) => [String(g), 0]));
  const decisions = [];
  for (const answer of answers) {
    const row = rows[Number(answer.row) - 1];
    const choice = typeof answer.choice === "string" ? answer.choice.trim() : "";
    if (!row || choice.length !== 1 || choice === "?") continue;
    const distinct = [...new Set(Object.values(row.readings))];
    const text = distinct[choice.charCodeAt(0) - 65];
    if (text === undefined) continue;
    decisions.push({ page: row.page, y: row.y, text });
    for (const [gap, reading] of Object.entries(row.readings)) {
      if (reading === text) votes[gap] += 1;
    }
  }
  if (decisions.length === 0) {
    return { gap: null, reason: "llm-undecided", votes, decisions };
  }
  // The candidate that agrees with the most answers; ties go to the value
  // closest to the library default (0.2).
  const ranked = Object.entries(votes).sort(
    ([ga, va], [gb, vb]) => vb - va || Math.abs(Number(ga) - 0.2) - Math.abs(Number(gb) - 0.2),
  );
  const [bestGap, bestVotes] = ranked[0];
  const agreement = bestVotes / decisions.length;
  if (agreement < minAgreement) {
    return { gap: null, reason: "low-agreement", agreement, votes, decisions };
  }
  return { gap: Number(bestGap), reason: "llm-majority", agreement, votes, decisions };
}

/**
 * The whole flow: find ambiguous rows, let the LLM decide on a sample,
 * and re-extract everything with the chosen gap (or `fallbackGap`).
 *
 * @param {(data: Uint8Array, options: {numberGap:number}) => Promise<any[]>|any[]} extract
 * @param {Uint8Array} data
 * @param {(prompt: string) => Promise<string>} ask
 * @param {{candidates?:number[], sample?:number, context?:string, fallbackGap?:number, minAgreement?:number}} [options]
 */
export async function extractWithLlmCheck(extract, data, ask, options = {}) {
  const found = await findAmbiguousRows(extract, data, options);
  const choice = await chooseNumberGap(found, ask, options);
  const numberGap = choice.gap ?? options.fallbackGap ?? 0.2;
  const items = await extract(data, { numberGap });
  return {
    numberGap,
    items,
    rows: rowsOf(items, options),
    check: { ...choice, ambiguousRows: found.ambiguous.length, rowsChecked: found.rowsChecked },
  };
}

// ── Any knob: compare whole outputs, let the LLM pick ─────────────────────
//
// `findAmbiguousRows` works on positioned rows and one knob. The functions
// below work on any output (usually the Markdown, where tables appear) and
// any knob: run the extraction under each candidate tuning
// ("knob=value,…"), keep only the lines where the outputs differ, and ask
// the LLM which output reads right. The lines all candidates share never
// reach the LLM.

/**
 * Run `run(data, {tuning})` (returns text) under each candidate tuning and
 * collect the lines each output has that the others do not.
 *
 * @param {(data: Uint8Array, options: {tuning: string}) => Promise<string>|string} run
 * @param {Uint8Array} data
 * @param {string[]} candidates  e.g. ["", "rule_join_gap=4", "short_rule_ratio=0.1"]
 * @param {{maxLines?: number}} [options]
 */
export async function compareTunings(run, data, candidates, { maxLines = 25 } = {}) {
  const outputs = [];
  for (const tuning of candidates) {
    outputs.push(String(await run(data, { tuning })));
  }
  const lineSets = outputs.map((o) => new Set(o.split("\n").map((l) => l.trimEnd()).filter(Boolean)));
  const distinct = [...new Set(outputs)];
  const unique = lineSets.map((set, i) =>
    [...set].filter((line) => lineSets.some((other, j) => j !== i && !other.has(line))).slice(0, maxLines),
  );
  return { candidates, outputs, unique, identical: distinct.length === 1 };
}

/** The prompt asking which output is right; outputs are labelled A, B, C… */
export function buildTuningPrompt(compared, { context } = {}) {
  const blocks = compared.candidates.map(
    (_, i) =>
      `Output ${String.fromCharCode(65 + i)} — lines only this output has:\n` +
      (compared.unique[i].length ? compared.unique[i].join("\n") : "(none)"),
  );
  return [
    "The same PDF page(s) were extracted several times with different layout",
    "settings. Below, for each output, are only the lines where it differs from",
    "the others (Markdown; tables use | between cells, right-to-left tables are",
    "written rightmost column first). Pick the output that is most faithful to a",
    "real document: whole words with normal spacing, numbers not glued or split,",
    "every table row on its own line with the same columns, no empty phantom",
    "columns, no text from outside the table inside a cell.",
    context ? `\nContext: ${context}` : "",
    "",
    blocks.join("\n\n"),
    "",
    'Answer with JSON only: {"choice":"A","reason":"…"}. Use "?" if they are equally good.',
  ].join("\n");
}

/**
 * Pick the candidate tuning the LLM prefers. Returns `tuning: null` when
 * all outputs are identical or the LLM cannot tell.
 *
 * @param {(data: Uint8Array, options: {tuning: string}) => Promise<string>|string} run
 * @param {Uint8Array} data
 * @param {(prompt: string) => Promise<string>} ask
 * @param {{candidates: string[], context?: string, maxLines?: number}} options
 */
export async function chooseTuning(run, data, ask, options) {
  const compared = await compareTunings(run, data, options.candidates, options);
  if (compared.identical) {
    return { tuning: null, reason: "identical-outputs", compared };
  }
  const reply = await ask(buildTuningPrompt(compared, options));
  const match = String(reply).match(/\{[\s\S]*\}/);
  let choice = "?";
  let why = "";
  try {
    const parsed = match ? JSON.parse(match[0]) : {};
    choice = typeof parsed.choice === "string" ? parsed.choice.trim() : "?";
    why = parsed.reason ?? "";
  } catch {
    // Unparseable: undecided.
  }
  const index = choice.length === 1 ? choice.charCodeAt(0) - 65 : -1;
  if (index < 0 || index >= compared.candidates.length) {
    return { tuning: null, reason: "llm-undecided", compared };
  }
  return {
    tuning: compared.candidates[index],
    reason: "llm-choice",
    why,
    output: compared.outputs[index],
    compared,
  };
}

/**
 * A tool definition (Anthropic tool-use format) that lets an LLM agent call
 * the extractor with knobs of its choosing and look at the result. Build it
 * from the engine's own `listKnobs()` so the descriptions match the build.
 *
 * @param {{name:string,unit:string,auto:string,effect:string}[]} knobs
 */
export function extractionToolDefinition(knobs) {
  const lines = knobs.map((k) => `- ${k.name} (${k.unit}; auto: ${k.auto}): ${k.effect}`);
  return {
    name: "extract_pdf",
    description:
      "Extract the PDF as Markdown. Optionally pass layout knobs when the previous output " +
      "looked wrong (glued words, swapped numbers, merged or split table columns). " +
      "Unlisted knobs stay auto.",
    input_schema: {
      type: "object",
      properties: {
        tuning: {
          type: "string",
          description: `Comma-separated knob=value pairs, value a number or "auto". Knobs:\n${lines.join("\n")}`,
        },
        pages: { type: "array", items: { type: "integer" }, description: "1-indexed pages" },
      },
    },
  };
}
