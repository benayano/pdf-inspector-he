// The PDF engine behind the invoice layer, for Node: either the WebAssembly
// Edge package or the native `pdf2md` binary, behind ONE interface — the
// subset of the wasm API the JS layer uses:
//
//   processPdf(bytes, { includePageMarkers, tuning, pages, numberGap }) -> { pdfType, pageCount, markdown }
//   extractTextWithPositions(bytes, { tuning, pages, numberGap })     -> items[]
//   classifyPdf(bytes)                                                -> { pdfType, pageCount }
//   listKnobs()                                                       -> [{ name, unit, auto, effect }]
//   invoiceCall(method, requestJson, bytes)                           -> JSON (src/invoice/api.rs)
//
// pdfType is always the wasm spelling: TextBased / Scanned / Mixed / ImageBased.
// Node-only (child_process, fs); not part of the Edge package.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The wasm Edge package (built by he/tools/build-edge.mjs) in `dir`, loaded. */
export async function wasmEngine(dir) {
  const { load } = await import(pathToFileURL(join(resolve(dir), "edge.mjs")).href);
  return load();
}

const PDF_TYPES = { text_based: "TextBased", scanned: "Scanned", mixed: "Mixed", image_based: "ImageBased" };

/** The repo's own release binary, if it was built. */
export function defaultBinary() {
  const bin = fileURLToPath(new URL("../target/release/pdf2md", import.meta.url));
  return existsSync(bin) ? bin : null;
}

/**
 * The native `pdf2md` binary as an engine. Each distinct byte array is
 * written to a temporary file once (the binary reads paths); call
 * `close()` to remove them.
 */
export function cliEngine(bin = defaultBinary() ?? "pdf2md") {
  const dir = mkdtempSync(join(tmpdir(), "pdf-inspector-he-"));
  const files = new WeakMap();
  let n = 0;
  const fileOf = (bytes) => {
    let path = files.get(bytes);
    if (!path) {
      path = join(dir, `${n++}.pdf`);
      writeFileSync(path, bytes);
      files.set(bytes, path);
    }
    return path;
  };
  const tuningArgs = ({ tuning, numberGap } = {}) => {
    const parts = [tuning, numberGap != null ? `number_gap=${numberGap}` : ""].filter(Boolean);
    return parts.length ? ["--tune", parts.join(",")] : [];
  };
  const pageArgs = ({ pages } = {}) => (pages?.length ? ["--select-pages", pages.join(",")] : []);
  const run = (args, input) => execFileSync(bin, args, { maxBuffer: 256 * 1024 * 1024, input }).toString();

  return {
    processPdf(bytes, options = {}) {
      const json = JSON.parse(
        run([
          "--json",
          ...(options.includePageMarkers ? ["--pages"] : []),
          ...tuningArgs(options),
          ...pageArgs(options),
          fileOf(bytes),
        ]),
      );
      return {
        pdfType: PDF_TYPES[json.pdf_type] ?? json.pdf_type,
        pageCount: json.page_count,
        markdown: json.markdown ?? "",
        pagesNeedingOcr: json.pages_needing_ocr ?? [],
        producer: json.producer ?? null,
      };
    },
    extractTextWithPositions(bytes, options = {}) {
      const json = JSON.parse(run(["--items-json", ...tuningArgs(options), ...pageArgs(options), fileOf(bytes)]));
      return Array.isArray(json) ? json : json.items ?? [];
    },
    /** The Rust invoice layer (pdf2md --invoice-call): readInvoice() uses it. */
    invoiceCall(method, request, data) {
      return run(["--invoice-call", method, ...(data?.length ? [fileOf(data)] : [])], request || "{}");
    },
    classifyPdf(bytes) {
      const json = JSON.parse(run(["--detect-only", "--json", fileOf(bytes)]));
      return { pdfType: PDF_TYPES[json.pdf_type] ?? json.pdf_type, pageCount: json.page_count };
    },
    listKnobs() {
      // "name (unit; auto: …)\n    effect" blocks.
      const out = run(["--list-knobs"]);
      const knobs = [];
      for (const m of out.matchAll(/^(\w+) \((.*?); auto: (.*)\)\n\s+(.*)$/gm)) {
        knobs.push({ name: m[1], unit: m[2], auto: m[3], effect: m[4] });
      }
      return knobs;
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * "cli:<path>" | "cli" | "wasm:<dir>" -> an engine. With no spec: the repo's
 * release binary if built, else `pdf2md` on PATH.
 */
export async function engineFromSpec(spec) {
  if (!spec || spec === "cli") return cliEngine();
  if (spec.startsWith("cli:")) return cliEngine(spec.slice(4));
  if (spec.startsWith("wasm:")) return wasmEngine(spec.slice(5));
  throw new Error(`engine: expected cli, cli:<pdf2md path> or wasm:<edge package dir>, got "${spec}"`);
}
