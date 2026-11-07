// Example Supabase Edge Function: POST a PDF, get rows back.
//
// Layout (inside your Supabase project):
//   supabase/functions/parse-invoice/index.ts        ← this file
//   supabase/functions/parse-invoice/pdf-inspector/  ← the `pdf-inspector-he-wasm-deno`
//                                                      artifact / release zip, unpacked
// Secret: ANTHROPIC_API_KEY (supabase secrets set ANTHROPIC_API_KEY=...)
//
// Without the key the function still works and uses the default gap (0.2).
import * as pdf from "./pdf-inspector/pdf_inspector.js";
import { extractWithLlmCheck } from "./pdf-inspector/rtl-check.mjs";

const extract = (data: Uint8Array, options: { numberGap: number }) =>
  pdf.extractTextWithPositions(data, options);

async function askClaude(prompt: string): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return "";
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) throw new Error(`Claude ${response.status}: ${await response.text()}`);
  const body = await response.json();
  return body.content?.map((c: { text?: string }) => c.text ?? "").join("") ?? "";
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("POST a PDF", { status: 405 });
  const data = new Uint8Array(await request.arrayBuffer());

  // Scanned PDFs have no text layer: route them to OCR instead.
  const kind = pdf.classifyPdf(data);
  if (kind.pdfType !== "TextBased") {
    return Response.json({ needsOcr: true, ...kind });
  }

  const result = await extractWithLlmCheck(extract, data, askClaude, {
    context: "Hebrew supplier invoice, line items table",
    sample: 12,
  });
  return Response.json({
    numberGap: result.numberGap,
    check: result.check,
    rows: result.rows,
  });
});
