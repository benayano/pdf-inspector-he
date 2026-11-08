// Invoice layer over pdf-inspector output.
//
// Takes the Markdown (`processPdf` / `pdf2md --pages`) and, when available,
// the positioned items (`extractTextWithPositions` / `pdf2md --items-json`)
// and returns the invoice as data:
//
//   - lines:   the item table, merged across pages, every cell normalized
//              (amounts, units, percentages, trailing minus signs) and every
//              row checked: quantity x price (less discount) = line total
//   - header:  the blocks above the table, kept apart (the customer block and
//              the dates block that the Markdown interleaves line by line),
//              and their "label: value" fields
//   - totals:  the totals box, label -> amount, with roles (subtotal,
//              discount, after discount, VAT, total, balance)
//   - checks:  sum of lines vs subtotal, discount, VAT, grand total
//
// Nothing here guesses silently: a check that cannot run is absent, a check
// that fails says by how much.

const RTL = /[֐-׿؀-ۿ]/;

// ---------------------------------------------------------------- amounts

const UNIT_ALIASES = new Map([
  ['ש"ח', "ILS"],
  ["ש״ח", "ILS"],
  ["שח", "ILS"],
  ["₪", "ILS"],
  ["NIS", "ILS"],
  ["ILS", "ILS"],
  ["$", "USD"],
  ["USD", "USD"],
  ["€", "EUR"],
  ["EUR", "EUR"],
]);
const CURRENCY_FIRST = /^(₪|\$|€|ש"ח|ש״ח)\s*(.+)$/;
const NUMBER =
  /^\(?\s*([-−])?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(%)?\s*([-−])?\s*\)?\s*(.*)$/;
const UNIT_TEXT = /^[\p{L}"'׳״.₪$€%]+(?: [\p{L}"'׳״.]+)?$/u;

/**
 * Parses an amount as invoices print it: "1,210.10", "461.54-" (trailing
 * minus), "-461.54", "(0.04%-)", "101.69 ש"ח", "60.80 מטר", "1.00 יח'",
 * "38.00%", "₪ 12.5". Returns null for anything that is not one amount
 * (dates, codes, sentences).
 * @returns {{value:number, unit:string|null, currency:string|null, percent:boolean, raw:string}|null}
 */
export function parseAmount(raw) {
  if (raw == null) return null;
  let text = String(raw).replace(/ /g, " ").trim();
  if (!text) return null;
  let unit = null;
  const first = CURRENCY_FIRST.exec(text);
  if (first) {
    unit = first[1];
    text = first[2].trim();
  }
  const m = NUMBER.exec(text);
  if (!m) return null;
  const [, lead, int, frac, pct, trail, restRaw] = m;
  const rest = restRaw.trim();
  if (rest) {
    if (unit || !UNIT_TEXT.test(rest) || rest.length > 12) return null;
    unit = rest;
  }
  if (lead && trail) return null;
  let value = Number(int.replace(/,/g, "") + (frac ? "." + frac : ""));
  if (lead || trail) value = -value;
  const percent = Boolean(pct) || unit === "%";
  const currency = unit ? UNIT_ALIASES.get(unit) ?? null : null;
  return {
    value,
    unit: percent ? "%" : unit,
    currency,
    percent,
    raw: String(raw).trim(),
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- tables

function splitRow(line) {
  const cells = line.split("|");
  return cells.slice(1, cells.length - 1).map((c) => c.trim());
}

/** Every Markdown table, with the page it is on. */
export function markdownTables(markdown) {
  const tables = [];
  let page = 1;
  let current = null;
  for (const line of markdown.split("\n")) {
    const pageMark = /^<!-- Page (\d+) -->/.exec(line);
    if (pageMark) page = Number(pageMark[1]);
    if (!line.startsWith("|")) {
      current = null;
      continue;
    }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    if (!current) {
      current = { page, header: cells, rows: [] };
      tables.push(current);
    } else {
      current.rows.push({ page, cells });
    }
  }
  return tables;
}

const sameHeader = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * Joins tables that continue one another: same header, and (when the first
 * column numbers the rows) numbering that carries on rather than restarting.
 */
export function mergeTables(tables) {
  const merged = [];
  for (const table of tables) {
    const last = merged[merged.length - 1];
    const firstNumber = Number(table.rows[0]?.cells[0]);
    const lastNumber = Number(last?.rows[last.rows.length - 1]?.cells[0]);
    const restarts = Number.isInteger(firstNumber) && Number.isInteger(lastNumber) && firstNumber <= lastNumber;
    if (last && sameHeader(last.header, table.header) && !restarts) {
      last.rows.push(...table.rows);
      last.pages.push(table.page);
    } else {
      merged.push({ header: table.header, rows: [...table.rows], pages: [table.page] });
    }
  }
  return merged;
}

const ROLE_PATTERNS = [
  ["deliveryNote", /^תעודה$|תעודת משלוח|delivery note/i],
  ["order", /^הזמנה$|^order$|purchase order/i],
  ["netUnitPrice", /(מחיר|price).*(אחרי|after|נטו|net)/i],
  ["unitPrice", /מחיר ל?יח|מחיר יחידה|unit price|^price$/i],
  ["discount", /הנחה|discount/i],
  ["quantity", /כמות|qty|quantity/i],
  ["total", /סה"כ|סה״כ|סכום|total|amount/i],
  // A printed site / project column ("תאור אתר") must win over the
  // description pattern (which also matches "תאור"), or the site's text
  // becomes the item's description on every row that names a site.
  ["site", /אתר|פרויקט|^site\b|project/i],
  ["description", /תאור|תיאור|description|פריט|item/i],
  ["sku", /מק"ט|מק״ט|sku|catalog/i],
  ["date", /תאריך|date/i],
];

function columnRoles(header) {
  const roles = header.map((name) => {
    for (const [role, pattern] of ROLE_PATTERNS) if (pattern.test(name)) return role;
    return null;
  });
  // The row-number column: unnamed, or "#"/"ש."/"מס'".
  if (roles[0] == null && /^(|#|ש\.|מס'?|no\.?)$/i.test(header[0])) roles[0] = "index";
  return roles;
}

/** Checks quantity x price = line total, allowing the rounding the price carries. */
export function checkLine(values) {
  const { quantity, unitPrice, netUnitPrice, discount, total } = values;
  if (quantity == null || total == null) return null;
  // Both the price and the quantity may be printed rounded to cents:
  // 0.67 kg is often 2/3 kg.
  const price = Math.abs(netUnitPrice ?? unitPrice ?? 0);
  const tolerance = 0.011 + Math.abs(quantity) * 0.005 + price * 0.005;
  const candidates = [];
  if (unitPrice != null) {
    const pct = discount ?? 0;
    candidates.push(quantity * unitPrice * (1 - pct / 100));
  }
  if (netUnitPrice != null) candidates.push(quantity * netUnitPrice);
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => (Math.abs(b - total) < Math.abs(a - total) ? b : a));
  const diff = round2(total - best);
  return { ok: Math.abs(total - best) <= tolerance, expected: round2(best), diff };
}

/** The item table: the merged table with the most rows that has a total column. */
export function lineItems(markdown) {
  const tables = mergeTables(markdownTables(markdown));
  const scored = tables
    .map((t) => ({ t, roles: columnRoles(t.header) }))
    .filter(({ roles }) => roles.includes("total") && roles.includes("quantity"));
  if (!scored.length) return null;
  scored.sort((a, b) => b.t.rows.length - a.t.rows.length);
  const { t, roles } = scored[0];
  const totalAt = roles.lastIndexOf("total");
  const columns = t.header.map((name, i) => ({
    name,
    role: roles[i] === "total" && i !== totalAt ? null : roles[i],
  }));
  const rows = t.rows.map(({ page, cells }) => {
    const values = {};
    const parsed = cells.map((cell, i) => {
      const amount = parseAmount(cell);
      const role = columns[i]?.role;
      if (role && amount && ["quantity", "unitPrice", "netUnitPrice", "discount", "total"].includes(role)) {
        values[role] = amount.value;
        if (role === "quantity" && amount.unit) values.unit = amount.unit;
      } else if (role === "index" && /^\d+$/.test(cell)) {
        values.index = Number(cell);
      } else if (role && cell && !values[role]) {
        values[role] = cell;
      }
      return amount;
    });
    return { page, cells, amounts: parsed, values, check: checkLine(values) };
  });
  return { columns, rows, pages: t.pages };
}

// ---------------------------------------------------------------- items

const num = (item, camel, snake) => item[camel] ?? item[snake];

function normalizeItems(input) {
  const items = Array.isArray(input) ? input : input?.items ?? [];
  return items
    .filter((i) => (i.item_type ?? i.itemType ?? "text") === "text")
    .map((i) => ({
      text: i.text,
      page: i.page,
      x: i.x,
      y: i.y,
      width: i.width,
      height: i.height,
      fontSize: num(i, "fontSize", "font_size") ?? i.height,
      bold: Boolean(num(i, "isBold", "is_bold")),
      rotation: i.rotation ?? 0,
    }))
    .filter((i) => i.text.trim() && isUpright(i));
}

function isUpright(item) {
  const r = ((item.rotation % 360) + 360) % 360;
  if (r > 45 && r < 315) return false;
  // Positions without a rotation field: a box much taller than its em and
  // only an em wide is a vertical run.
  return !(item.height > item.fontSize * 3 && item.width <= item.fontSize * 1.5);
}

/** Groups a page's items into rows by baseline, each row in reading order. */
function rowsOf(items, rtl) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - item.y) <= Math.max(2, item.fontSize * 0.35)) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  for (const row of rows) row.items.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
  return rows;
}

/**
 * Splits text into label and value at a colon: "תאריך חשבונית: 31/08/26",
 * and the mirrored "ori@x.com :Email" a right-to-left line gives a Latin
 * label.
 */
export function splitField(text) {
  const t = text.trim();
  const mirrored = /^(\S+)\s+:([A-Za-z][\w .-]*)$/.exec(t);
  if (mirrored) return { label: mirrored[2].trim(), value: mirrored[1] };
  const at = t.indexOf(":");
  if (at <= 0) return null;
  const label = t.slice(0, at).trim();
  const value = t.slice(at + 1).trim();
  if (!label || /\d{1,2}$/.test(label) && /^\d{2}/.test(value)) return null; // a time, "21:01"
  return { label, value };
}

/**
 * Fields of a run of items read as one row: "label: value" inside one item,
 * or a label item followed in reading order by an amount item.
 */
function fieldsOfRow(items) {
  const fields = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const own = splitField(item.text);
    if (own) {
      if (own.value) fields.push({ ...own, page: item.page, y: item.y });
      else if (items[i + 1]) {
        fields.push({ label: own.label, value: items[i + 1].text.trim(), page: item.page, y: item.y });
        i++;
      }
      continue;
    }
    const next = items[i + 1];
    if (next && !parseAmount(item.text) && /\p{L}/u.test(item.text) && parseAmount(next.text)) {
      fields.push({ label: item.text.trim(), value: next.text.trim(), page: item.page, y: item.y });
      i++;
    }
  }
  return fields;
}

/**
 * Blocks of the header: items chain into one block when their boxes overlap
 * horizontally and they stand on adjacent lines. Two blocks side by side
 * (the customer on the right, the dates on the left) stay two blocks even
 * where their lines share a baseline.
 */
export function headerBlocks(items, rtl) {
  const n = items.length;
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = items[i];
      const b = items[j];
      const em = Math.max(a.fontSize, b.fontSize);
      const dy = Math.abs(a.y - b.y);
      const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const sameLineNeighbours = dy <= em * 0.35 && overlap > -em * 1.5;
      const stacked = dy > em * 0.35 && dy <= em * 1.8 && overlap > -1;
      if (sameLineNeighbours || stacked) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  const blocks = [...groups.values()].map((group) => {
    const lines = rowsOf(group, rtl).map((r) => r.items.map((i) => i.text.trim()).join(" "));
    const top = Math.max(...group.map((i) => i.y + i.fontSize));
    const left = Math.min(...group.map((i) => i.x));
    const right = Math.max(...group.map((i) => i.x + i.width));
    const fields = rowsOf(group, rtl).flatMap((r) => fieldsOfRow(r.items));
    return { page: group[0].page, top, left, right, lines, text: lines.join("\n"), fields };
  });
  // Reading order: top band first; within a band, from the reading edge.
  blocks.sort((a, b) => {
    if (Math.abs(a.top - b.top) > 12) return b.top - a.top;
    return rtl ? b.right - a.right : a.left - b.left;
  });
  return blocks;
}

// ---------------------------------------------------------------- totals

const TOTAL_ROLES = [
  ["balance", /נותר|יתרה|balance/i],
  ["afterDiscount", /אחרי הנחה|after discount/i],
  ["discount", /הנחה|discount/i],
  ["vat", /^מע"מ|^מע״מ|^vat\b/i],
  ["subtotal", /מחיר כולל|סה"כ לפני|סה״כ לפני|סכום ביניים|ללא מע"מ|subtotal/i],
  ["total", /סה"כ|סה״כ|לתשלום|^total/i],
];

function totalRole(label) {
  for (const [role, pattern] of TOTAL_ROLES) if (pattern.test(label)) return role;
  return null;
}

function totalsFrom(fields) {
  const totals = [];
  for (const f of fields) {
    const amount = parseAmount(f.value);
    if (!amount || amount.percent || !totalRole(f.label)) continue;
    const pct = /\(\s*([-−]?\d+(?:\.\d+)?)\s*%\s*([-−])?\s*\)/.exec(f.label);
    const percent = pct ? Number(pct[1].replace("−", "-")) * (pct[2] ? -1 : 1) : null;
    totals.push({
      label: f.label,
      value: amount.value,
      currency: amount.currency,
      percent,
      role: totalRole(f.label),
      page: f.page,
    });
  }
  return totals;
}

function check(name, expected, actual, tolerance = 0.011) {
  const diff = round2(actual - expected);
  return { name, ok: Math.abs(actual - expected) <= tolerance, expected: round2(expected), actual, diff };
}

export function totalsChecks(lines, totals) {
  const checks = [];
  const byRole = (role) => totals.find((t) => t.role === role);
  const subtotal = byRole("subtotal");
  const discount = byRole("discount");
  const after = byRole("afterDiscount");
  const vat = byRole("vat");
  const total = byRole("total");
  if (lines) {
    const sum = round2(lines.rows.reduce((s, r) => s + (r.values.total ?? 0), 0));
    const target = subtotal ?? (vat ? after : null) ?? total;
    if (target) checks.push({ ...check("lines-sum", sum, target.value), label: target.label });
    const bad = lines.rows.filter((r) => r.check && !r.check.ok);
    checks.push({
      name: "line-arithmetic",
      ok: bad.length === 0,
      checked: lines.rows.filter((r) => r.check).length,
      failed: bad.map((r) => ({ index: r.values.index, page: r.page, ...r.check })),
    });
  }
  if (subtotal && discount && after) {
    // The sign is printed inconsistently ("0.32-" for a surcharge, "0.36"
    // for a discount); the after-discount line settles it.
    const minus = subtotal.value - Math.abs(discount.value);
    const plus = subtotal.value + Math.abs(discount.value);
    const best = Math.abs(minus - after.value) <= Math.abs(plus - after.value) ? minus : plus;
    checks.push({ ...check("discount", best, after.value), sign: best === minus ? "minus" : "plus" });
  }
  const base = after ?? subtotal;
  if (vat && base && vat.percent != null) checks.push(check("vat", base.value * (vat.percent / 100), vat.value));
  if (total && base && vat) checks.push(check("grand-total", base.value + vat.value, total.value));
  return checks;
}

// ---------------------------------------------------------------- invoice

/**
 * The invoice with every row check and every totals check computed again
 * from the rows' `values` and the totals. For a caller that changed values
 * (a repair) and wants the same verdict parseInvoice would have given.
 */
export function recheck(invoice) {
  const lines = invoice.lines
    ? { ...invoice.lines, rows: invoice.lines.rows.map((r) => ({ ...r, check: checkLine(r.values) })) }
    : null;
  return { ...invoice, lines, checks: totalsChecks(lines, invoice.totals ?? []) };
}

/** Where the item table stands on a page: from its header to its last row. */
function tableSpan(items, lines, page) {
  const headerTexts = new Set(lines.columns.map((c) => c.name).filter(Boolean));
  const head = items.filter((i) => i.page === page && headerTexts.has(i.text.trim()));
  const pageRows = lines.rows.filter((r) => r.page === page);
  const last = pageRows[pageRows.length - 1];
  let bottom = null;
  if (last) {
    const tail = new Set(last.cells.filter(Boolean));
    const hits = items.filter((i) => i.page === page && tail.has(i.text.trim()));
    if (hits.length) bottom = Math.min(...hits.map((i) => i.y));
  }
  const top = head.length ? Math.max(...head.map((i) => i.y + i.fontSize)) : null;
  return { top, bottom };
}

/**
 * @param {{markdown: string, items?: object[]}} input
 */
export function parseInvoice({ markdown, items = [] }) {
  const lines = lineItems(markdown);
  const positioned = normalizeItems(items);
  const rtl = RTL.test(positioned.map((i) => i.text).join("") || markdown);
  const pages = [...new Set(positioned.map((i) => i.page))].sort((a, b) => a - b);

  const header = { blocks: [], fields: [] };
  let totalFields = [];
  if (lines && positioned.length) {
    const firstPage = lines.pages[0];
    const lastPage = Math.max(...lines.rows.map((r) => r.page));
    const first = tableSpan(positioned, lines, firstPage);
    if (first.top != null) {
      const above = positioned.filter((i) => i.page === firstPage && i.y > first.top);
      header.blocks = headerBlocks(above, rtl);
      header.fields = header.blocks.flatMap((b) => b.fields);
    }
    const last = tableSpan(positioned, lines, lastPage);
    if (last.bottom != null) {
      const below = positioned.filter((i) => i.page === lastPage && i.y < last.bottom - 1);
      totalFields = rowsOf(below, rtl).flatMap((r) => fieldsOfRow(r.items));
    }
    // A table that fills its page leaves the totals box for the next one,
    // under that page's repeated header: read it from its first totals row.
    for (const page of pages.filter((p) => p > lastPage)) {
      const rows = rowsOf(positioned.filter((i) => i.page === page), rtl);
      const start = rows.findIndex((r) => fieldsOfRow(r.items).some((f) => totalRole(f.label)));
      if (start >= 0) totalFields.push(...rows.slice(start).flatMap((r) => fieldsOfRow(r.items)));
    }
  } else if (!lines) {
    for (const page of pages) {
      header.blocks.push(...headerBlocks(positioned.filter((i) => i.page === page), rtl));
    }
    header.fields = header.blocks.flatMap((b) => b.fields);
  }
  const totals = totalsFrom(totalFields);
  return {
    rtl,
    header,
    lines,
    totals,
    footer: { fields: totalFields },
    checks: totalsChecks(lines, totals),
  };
}

// ---------------------------------------------------------------- records

/** Column order of {@link toRecords} and {@link toCsv}: stable, snake_case, ready for SQL. */
export const RECORD_COLUMNS = [
  "invoice_number",
  "invoice_date",
  "supplier_name",
  "supplier_tax_id",
  "line_no",
  "page",
  "date",
  "delivery_note",
  "order_ref",
  "sku",
  "description",
  "quantity",
  "unit",
  "unit_price",
  "discount_pct",
  "net_unit_price",
  "line_total",
  "currency",
  "check_ok",
  "check_diff",
  "site_text",
  "marker",
  "is_return",
];

/** A line priced at a shekel cent or less: a printed note ("לקח …"), not goods. */
export function isMarkerLine(values) {
  const price = Math.abs(values.unitPrice ?? values.netUnitPrice ?? 0);
  return values.total != null && Math.abs(values.total) <= 0.01 && price <= 0.01;
}

/** "חשבונית זיכוי" / "credit note" in the header: the signs mean the other thing. */
export function documentType(invoice) {
  const text = (invoice.header?.blocks ?? []).map((b) => b.text).join("\n");
  return /זיכוי|credit note/i.test(text) ? "credit" : "invoice";
}

/** "31/08/26" or "31.08.2026" -> "2026-08-31"; anything else -> null. */
export function isoDate(text) {
  const m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const day = Number(d);
  const month = Number(mo);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const firstField = (fields, pattern) => fields.find((f) => pattern.test(f.label) && f.value);

/**
 * The invoice's own facts, one object: who issued it, its number and date,
 * and its totals by role. Values not found are null, never guessed.
 */
export function invoiceInfo(invoice) {
  const fields = invoice.header?.fields ?? [];
  const taxField = firstField(fields, /עוסק מורשה|^ח\.?\s?פ\.?$|^ע\.?\s?מ\.?$|^vat (no|number)|^tax id/i);
  const supplierBlock = taxField
    ? // By value, not identity: an invoice that went through JSON (a Rust read,
      // a saved state) has separate copies in header.fields and the blocks.
      invoice.header.blocks.find((b) =>
        b.fields.some((f) => f.label === taxField.label && f.value === taxField.value && f.page === taxField.page && f.y === taxField.y),
      )
    : null;
  const numberField = firstField(fields, /מספר חשבונית|מספר תעודה|invoice (no|number)/i);
  let invoiceNumber = numberField?.value ?? null;
  if (!invoiceNumber) {
    const title = invoice.header?.blocks
      .flatMap((b) => b.lines)
      .map((l) => /חשבונית[^\n]*?\s*([A-Z]{0,4}\d{5,})/.exec(l))
      .find(Boolean);
    invoiceNumber = title?.[1] ?? null;
  }
  const dateField = firstField(fields, /תאריך חשבונית|^תאריך$|invoice date/i);
  const total = (role) => invoice.totals?.find((t) => t.role === role) ?? null;
  const currency = invoice.totals?.find((t) => t.currency)?.currency ?? null;
  return {
    document_type: documentType(invoice),
    invoice_number: invoiceNumber,
    invoice_date: isoDate(dateField?.value),
    supplier_name: supplierBlock?.lines[0] ?? null,
    supplier_tax_id: taxField ? taxField.value.replace(/\D/g, "") || null : null,
    subtotal: total("subtotal")?.value ?? null,
    discount: total("discount")?.value ?? null,
    after_discount: total("afterDiscount")?.value ?? null,
    vat_rate: total("vat")?.percent ?? null,
    vat: total("vat")?.value ?? null,
    total: total("total")?.value ?? null,
    currency,
    checks_ok: (invoice.checks ?? []).every((c) => c.ok),
  };
}

/**
 * One flat record per item line, with the invoice's own facts repeated on
 * each: ready for a spreadsheet, `COPY`, or an `insert(records)` call.
 * Numbers are numbers (a credit stays negative), dates ISO, missing values
 * null. Columns: {@link RECORD_COLUMNS}.
 */
export function toRecords(invoice) {
  const info = invoiceInfo(invoice);
  if (!invoice.lines) return [];
  const credit = info.document_type === "credit";
  return invoice.lines.rows.map((row, i) => {
    const v = row.values;
    const currencyOf = row.amounts.find((a) => a?.currency)?.currency ?? info.currency;
    return {
      invoice_number: info.invoice_number,
      invoice_date: info.invoice_date,
      supplier_name: info.supplier_name,
      supplier_tax_id: info.supplier_tax_id,
      line_no: v.index ?? i + 1,
      page: row.page,
      date: isoDate(v.date) ?? v.date ?? null,
      delivery_note: v.deliveryNote ?? null,
      order_ref: v.order ?? null,
      sku: v.sku ?? null,
      description: v.description ?? null,
      quantity: v.quantity ?? null,
      unit: v.unit ?? null,
      unit_price: v.unitPrice ?? null,
      discount_pct: v.discount ?? null,
      net_unit_price: v.netUnitPrice ?? null,
      line_total: v.total ?? null,
      currency: currencyOf ?? null,
      check_ok: row.check ? row.check.ok : null,
      check_diff: row.check ? row.check.diff : null,
      site_text: v.site ?? null,
      marker: isMarkerLine(v),
      // A line printed with a minus inside an ordinary invoice: goods returned.
      is_return: !credit && (v.total ?? 0) < 0,
    };
  });
}

function csvCell(value, excelSafe) {
  if (value == null) return "";
  let text = String(value);
  // Text from a PDF that starts like a formula would run as one in Excel.
  if (excelSafe && typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV text: a header row, CRLF line ends, RFC 4180 quoting.
 * For Excel (default): a BOM so Hebrew opens right, and text cells that
 * start with = + - @ prefixed with ' so they are not run as formulas.
 * For a database (`COPY … CSV HEADER`): `{ bom: false, excelSafe: false }`.
 */
export function toCsv(records, { columns = RECORD_COLUMNS, bom = true, excelSafe = true } = {}) {
  const lines = [columns.map((c) => csvCell(c, false)).join(",")];
  for (const record of records) {
    lines.push(columns.map((c) => csvCell(record[c], excelSafe)).join(","));
  }
  return (bom ? "\ufeff" : "") + lines.join("\r\n") + "\r\n";
}
