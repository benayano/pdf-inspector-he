# pdf-inspector

Fast PDF text extraction to structured Markdown. CLI binary: `pdf2md`. Detection binary: `detect-pdf`.

This is **pdf-inspector-he**, a fork with Hebrew / RTL invoice support. Using the
library from an LLM agent (features, knobs, tools, partial review): `docs/agent-guide.md`.

## Build & Test

```bash
cargo fmt                                    # format
cargo clippy -- -D warnings                  # lint (enforced, zero warnings)
cargo test                                   # unit + integration tests (267+ unit, 73+ integration)
cargo build --release                        # release binary for benchmarks
```

All three must pass before committing.

## Binaries

- `pdf2md` — extract PDF → Markdown. Supports `--json` for structured output.
- `detect-pdf` — classify PDF type (TextBased/Scanned/Mixed/ImageBased). Supports `--analyze --json`.

## Architecture

```
src/
  lib.rs                        – public API, process_pdf_with_options, encoding issue detection
  detector.rs                   – PDF type classification, tiled-scan detection, page sampling
  types.rs                      – TextItem, TextLine, PdfRect, PdfLine
  tounicode.rs                  – CMap/ToUnicode parsing, CID decoding
  text_utils.rs                 – CJK/RTL handling, Otsu threshold, ligature expansion, NFKC
  extractor/
    mod.rs                      – top-level extraction orchestrator
    content_stream.rs           – PDF operator state machine (Tj/TJ/Td/Tm/q/Q)
    geometry.rs                 – run boxes and baseline rotation shared by both content parsers
    fonts.rs                    – font width/encoding, CMapDecisionCache, TrueType cmap fallback
    layout.rs                   – column detection (histogram), newspaper/tabular classification,
                                  spanning-line pre-masking, sidebar detection
  tables/
    detect_rects.rs             – rect-based table detection (union-find clustering)
    detect_heuristic.rs         – heuristic table detection (gap-histogram, body-font tables)
    detect_lines.rs             – line-based table detection (H/V line grids)
    grid.rs                     – column/row boundaries, cell assignment
    format.rs                   – table→Markdown formatting, continuation row merging
  markdown/
    convert.rs                  – core line→Markdown loop, struct-tree role support
    analysis.rs                 – font stats, heading tiers, paragraph thresholds
    classify.rs                 – line classification (header, list, code, caption)
    preprocess.rs               – drop cap merging, heading line merging
    postprocess.rs              – dot leaders, hyphenation, page numbers, URL formatting
```

## Key design decisions

- **Primary audience is AI agents.** Output optimized for token efficiency and semantic quality, not visual formatting. No cosmetic padding.
- **Three table detection strategies** run in priority order: rect-based → line-based → heuristic. First valid result wins.
- **Column detection** uses horizontal projection histograms with valley detection. Multi-item spanning lines (titles, headers) are pre-masked using column-aware thresholds before column assignment.
- **Newspaper vs tabular** classification determines reading order: newspaper reads columns sequentially, tabular Y-interleaves them.
- **Tiled-scan detection** catches scanned PDFs with JBIG2/strip images where no single tile exceeds the template threshold but aggregate area does (≥2M pixels).
- **Garbage text upgrade** reclassifies Mixed PDFs as Scanned when extracted text is <50% alphanumeric.
- **Tagged PDF support** uses structure tree roles (H1-H6, P, L, Code, BlockQuote) when available, falling back to font-size heuristics.

## Testing

- **Unit tests**: inline `#[cfg(test)] mod tests` in each module with synthetic data.
- **Integration tests**: `tests/integration_tests.rs` with fixture PDFs in `tests/fixtures/`.
- **Regression suite**: sibling repo `pdf-evals` with ~200 snapshot PDFs. Run `cargo build --release` then `bench.py test` in that repo before committing. While iterating, prefer a subset run (`bench.py test -q` for the quick set, or `-s <name>` for a named test set) and save the full `bench.py test` for the final pre-commit check.
- **Semantic quality**: run `bench.py score` in `pdf-evals` for the semantic verdict (TEDS + MHS + reading order + char/word + list preservation, composited). Character-level diff alone misclassifies structural improvements (e.g., column-detection rewrites) as regressions — `score` is the tie-breaker. See `pdf-evals/CLAUDE.md` "Semantic scoring".

## Debugging

```bash
RUST_LOG=pdf_inspector::extractor::layout=debug cargo run --bin pdf2md -- file.pdf
RUST_LOG=pdf_inspector::tables=debug cargo run --bin pdf2md -- file.pdf
RUST_LOG=pdf_inspector::detector=debug cargo run --release --bin detect-pdf -- file.pdf
```

## Conventions

- Clippy: use `is_some_and(...)` not `map_or(false, ...)`
- lopdf quirk: `ParseError` is private — match by string for `InvalidFileHeader`
- Column limit for tables: 25 (wide statistical tables)
- `propagate_merged_cells` skipped for >10 columns (spanning rects = background fills)

## Hebrew fork (pdf-inspector-he)

- **Before every commit**, in addition to fmt/clippy/test:
  `cargo build --release --bin pdf2md && node he/regression.mjs && node --test he/*.test.mjs`.
  The regression runs the four anonymized invoices in `he/fixtures/invoices/`: item rows,
  column counts, the full Markdown, and the invoice layer's checks (lines, discount, VAT, totals).
- `node he/regression.mjs --update` rewrites the expected Markdown. Only after an intended change,
  and read the diff first. A failing invoice check is fixed in code, never in `expectations.json`.
- **Knobs** (`src/tuning.rs`): every new layout threshold that could need per-document tuning
  becomes a knob with an `auto` default, a unit and an effect line (`KNOBS`), exposed through
  CLI `--tune`, Python, napi and wasm. `auto` must keep the corpus green.
- **JS layer** (`he/`): `rtl-check.mjs` (partial LLM review), `invoice.mjs` (invoice data, checks,
  records, CSV). Each has a `.d.ts`; keep them in sync. Both ship in the wasm packages
  (`.github/workflows/he-build.yml`).
- **Privacy**: no real supplier/customer names in the repo. New invoices go through
  `he/tools/anonymize_pdf.py`; the private names list stays outside git.
- **Toolchain**: if the pinned toolchain is unavailable, `RUSTUP_TOOLCHAIN=stable`; use `-j 2` on small machines.
- Hebrew notes on each fix: `he/README.md`.
