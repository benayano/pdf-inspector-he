#!/usr/bin/env python3
"""Anonymize an invoice PDF for the regression corpus, keeping its layout.

The text stays where it was, in the same fonts and the same drawing
operators; only the characters of sensitive words change, glyph by glyph,
to other characters of the same kind (Hebrew letter -> Hebrew letter, digit
-> digit, Latin -> Latin) that the embedded font subset already holds. So
the extractor meets exactly the same geometry, operators and fonts as in the
original — which is what a regression test needs — without the names.

What changes:
  * outside the item table (header, customer box, totals, footer): every
    word that is not a known label (KEEP below) and every identifier-like
    digit run (5+ digits without a decimal point, e.g. phone, company id,
    bank account); amounts and dates stay so totals still add up;
  * inside the item table: words listed in --names (people, sites) and
    phone numbers in descriptions (8+ digits, no letters);
  * every image is replaced by a flat grey image of the same size (logos);
  * document info (title, author) and link annotations are removed.

The table zone of a page runs from the line holding the column header
("תאור מוצר") down to the first line holding a totals label ("מחיר כולל",
"ברקוד"); a page without that header is all "outside".

Usage:
  python3 -I anonymize_pdf.py in.pdf out.pdf --names names.txt [--seed S]

names.txt (one word per line) holds the private names; keep it out of the
repository.
"""

import argparse
import hashlib
import re
import sys
import zlib

import pikepdf

KEEP = set(
    """
לכבוד תאריך חשבונית הדפסה שעת מספר תעודה פרטים טלפון פקס עוסק מורשה מס מס.
תיק ניכויים ברקוד לתשלום עד תנאי תשלום לקוח סוכן סניף חברה מע"מ במע"מ יתרה
בהנח"ש מחיר כולל הנחה כללית אחרי סה"כ נותר מקור מרכזת מסמך ממוחשב הקצאה פרטי
חשבון להעברה שם המוטב בנק תאור מוצר כמות ליחידה ליח' מק"ט ש. התעודה אתר הזמנה
שוטף ש"ח יח' מטר חש. Email e-mail E-mail Page of מס' (מסמך ממוחשב) - :
""".split()
)

HEBREW = [chr(c) for c in range(0x05D0, 0x05EB)]
FINALS = set("ךםןףץ")
DIGITS = list("0123456789")
LOWER = [chr(c) for c in range(ord("a"), ord("z") + 1)]
UPPER = [chr(c) for c in range(ord("A"), ord("Z") + 1)]


def char_class(ch):
    if ch in FINALS:
        return "final"
    if "א" <= ch <= "ת":
        return "hebrew"
    if ch.isdigit():
        return "digit"
    if "a" <= ch <= "z":
        return "lower"
    if "A" <= ch <= "Z":
        return "upper"
    return None


# ── ToUnicode / widths ────────────────────────────────────────────────────


def parse_tounicode(stream):
    data = stream.read_bytes().decode("latin1")
    mapping = {}

    def u16(hexstr):
        b = bytes.fromhex(hexstr)
        return b.decode("utf-16-be", errors="replace")

    for block in re.findall(r"beginbfchar(.*?)endbfchar", data, re.S):
        for src, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            mapping[int(src, 16)] = u16(dst)
    for block in re.findall(r"beginbfrange(.*?)endbfrange", data, re.S):
        for m in re.finditer(
            r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[(.*?)\])", block, re.S
        ):
            lo, hi = int(m.group(1), 16), int(m.group(2), 16)
            if m.group(4):
                base = bytes.fromhex(m.group(4))
                start = int.from_bytes(base, "big")
                for i, code in enumerate(range(lo, hi + 1)):
                    mapping[code] = (start + i).to_bytes(len(base), "big").decode(
                        "utf-16-be", errors="replace"
                    )
            else:
                dsts = re.findall(r"<([0-9A-Fa-f]+)>", m.group(5))
                for i, code in enumerate(range(lo, hi + 1)):
                    if i < len(dsts):
                        mapping[code] = u16(dsts[i])
    return mapping


class Font:
    def __init__(self, obj):
        self.obj = obj
        self.to_unicode = parse_tounicode(obj.ToUnicode) if "/ToUnicode" in obj else {}
        self.reverse = {}
        for code, text in self.to_unicode.items():
            if len(text) == 1:
                self.reverse.setdefault(text, code)
        self.widths = {}
        self.default_width = 1000
        if "/DescendantFonts" in obj:
            desc = obj.DescendantFonts[0]
            self.default_width = float(desc.get("/DW", 1000))
            w = list(desc.get("/W", []))
            i = 0
            while i < len(w):
                first = int(w[i])
                if isinstance(w[i + 1], pikepdf.Array):
                    for k, v in enumerate(w[i + 1]):
                        self.widths[first + k] = float(v)
                    i += 2
                else:
                    last, value = int(w[i + 1]), float(w[i + 2])
                    for c in range(first, last + 1):
                        self.widths[c] = value
                    i += 3
        self.by_class = {}
        for ch in self.reverse:
            cls = char_class(ch)
            if cls:
                self.by_class.setdefault(cls, []).append(ch)
        for v in self.by_class.values():
            v.sort()

    def width(self, code):
        return self.widths.get(code, self.default_width)


# ── content walk ──────────────────────────────────────────────────────────


def mul(a, b):
    return [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]


class Glyph:
    __slots__ = ("stream", "op", "elem", "pos", "char", "x", "y", "size", "font", "end")

    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def walk(pdf, owner, ctm, glyphs, streams, seen, depth=0):
    """Collect every shown glyph of `owner` (a page or a form) with its
    device position; forms are walked recursively."""
    if depth > 6:
        return
    key = owner.objgen if hasattr(owner, "objgen") else id(owner)
    resources = owner.get("/Resources", pikepdf.Dictionary())
    fonts = {}
    if "/Font" in resources:
        for name, f in resources.Font.items():
            fonts[name] = Font(f)
    xobjects = resources.get("/XObject", pikepdf.Dictionary())
    source = owner if isinstance(owner, pikepdf.Stream) else pikepdf.Page(owner)
    ops = list(pikepdf.parse_content_stream(source))
    sid = len(streams)
    streams.append((owner, ops))
    stack = []
    tm = tlm = [1, 0, 0, 1, 0, 0]
    font, size, tc, tw, th, tl, rise = None, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0
    for oi, (operands, op) in enumerate(ops):
        op = str(op)
        if op == "q":
            stack.append((ctm, font, size, tc, tw, th, tl, rise))
        elif op == "Q" and stack:
            ctm, font, size, tc, tw, th, tl, rise = stack.pop()
        elif op == "cm":
            ctm = mul([float(v) for v in operands], ctm)
        elif op == "BT":
            tm = tlm = [1, 0, 0, 1, 0, 0]
        elif op == "Tf":
            font = fonts.get(str(operands[0]))
            size = float(operands[1])
        elif op == "Tc":
            tc = float(operands[0])
        elif op == "Tw":
            tw = float(operands[0])
        elif op == "Tz":
            th = float(operands[0]) / 100
        elif op == "TL":
            tl = float(operands[0])
        elif op == "Ts":
            rise = float(operands[0])
        elif op in ("Td", "TD"):
            tx, ty = float(operands[0]), float(operands[1])
            if op == "TD":
                tl = -ty
            tlm = mul([1, 0, 0, 1, tx, ty], tlm)
            tm = tlm
        elif op == "Tm":
            tlm = tm = [float(v) for v in operands]
        elif op == "T*":
            tlm = mul([1, 0, 0, 1, 0, -tl], tlm)
            tm = tlm
        elif op in ("Tj", "'", '"', "TJ"):
            if op in ("'", '"'):
                tlm = mul([1, 0, 0, 1, 0, -tl], tlm)
                tm = tlm
            elems = operands[-1] if op == "TJ" else [operands[-1]]
            for ei, el in enumerate(elems):
                if not isinstance(el, pikepdf.String):
                    try:
                        adj = float(el)
                    except (TypeError, ValueError):
                        continue
                    tm = mul([1, 0, 0, 1, -adj / 1000 * size * th, 0], tm)
                    continue
                data = bytes(el)
                for pos in range(0, len(data) - 1, 2):
                    code = int.from_bytes(data[pos : pos + 2], "big")
                    trm = mul(mul([size * th, 0, 0, size, 0, rise], tm), ctm)
                    w = font.width(code) if font else 1000
                    advance = (w / 1000 * size + tc) * th
                    end = mul(mul([size * th, 0, 0, size, advance, rise], tm), ctm)
                    ch = font.to_unicode.get(code, "") if font else ""
                    glyphs.append(
                        Glyph(
                            stream=sid,
                            op=oi,
                            elem=ei if op == "TJ" else None,
                            pos=pos,
                            char=ch,
                            x=trm[4],
                            y=trm[5],
                            size=abs(size * (ctm[3] if ctm[3] else 1)),
                            font=font,
                            end=end[4],
                        )
                    )
                    tm = mul([1, 0, 0, 1, advance, 0], tm)
        elif op == "Do":
            name = str(operands[0])
            xo = xobjects.get(name)
            if xo is not None and xo.get("/Subtype") == "/Form" and xo.objgen not in seen:
                seen.add(xo.objgen)
                matrix = [float(v) for v in xo.get("/Matrix", [1, 0, 0, 1, 0, 0])]
                walk(pdf, xo, mul(matrix, ctm), glyphs, streams, seen, depth + 1)


# ── words, zones, decisions ───────────────────────────────────────────────


def words_of(glyphs):
    """Group glyphs into lines (baseline) and words (gaps), in screen order."""
    lines = []
    for g in sorted(glyphs, key=lambda g: (-round(g.y, 0), g.x)):
        if g.char.strip() == "":
            continue
        for line in lines:
            if abs(line[0] - g.y) <= 0.3 * max(g.size, 1):
                line[1].append(g)
                break
        else:
            lines.append([g.y, [g]])
    words = []
    for y, gs in lines:
        gs.sort(key=lambda g: g.x)
        word = [gs[0]]
        for prev, g in zip(gs, gs[1:]):
            if g.x - min(prev.end, prev.x + prev.size) > 0.18 * max(g.size, 1):
                words.append(word)
                word = []
            word.append(g)
        words.append(word)
    return words


def text_variants(word):
    visual = "".join(g.char for g in word)
    return {visual, visual[::-1]}


def stripped(text):
    return text.strip(":,.()[]*\"'-")


def is_identifier(text):
    digits = re.findall(r"\d+", text)
    longest = max((len(d) for d in digits), default=0)
    amount = bool(re.fullmatch(r"-?[\d,]*\.\d+-?", text))
    return longest >= 5 and not amount


def is_phone(text):
    """A phone number written into a description: digits, dashes and a
    plus only, at least 8 digits (catalogue codes carry letters)."""
    return bool(re.fullmatch(r"\+?[\d\-+]+", text)) and len(re.sub(r"\D", "", text)) >= 8


def decide(words, names, page_lines):
    """Words whose letters/digits are replaced, and how much of each."""
    # Table zone from the header line ("תאור מוצר") down to the first
    # totals line ("מחיר כולל" / "ברקוד"), or, on a page without totals,
    # down to the last line holding an amount with two decimals.
    def ys_of(word):
        return [
            w[0].y for w in words if any(stripped(v) == word for v in text_variants(w))
        ]

    describe = ys_of("תאור")
    header = [y for y in ys_of("מוצר") if any(abs(y - d) <= 3 for d in describe)]
    # A header cell can hold two lines, one above the header baseline.
    top = max(header) + 1.4 * max((w[0].size for w in words), default=10) if header else None
    bottom = None
    if top is not None:
        totals = ys_of("כולל") + ys_of("ברקוד")
        below = [y for y in totals if y < top - 5]
        if below:
            bottom = max(below) + 1
        else:
            amounts = [
                w[0].y
                for w in words
                if w[0].y < top
                and any(re.fullmatch(r"-?[\d,]+\.\d\d-?", v) for v in text_variants(w))
            ]
            bottom = min(amounts) - 3 if amounts else None
    out = []
    for w in words:
        y = w[0].y
        in_table = top is not None and y <= top and (bottom is None or y > bottom)
        variants = {stripped(v) for v in text_variants(w)} | text_variants(w)
        if in_table:
            if variants & names:
                out.append((w, "all"))
            elif any(is_phone(v) for v in variants):
                out.append((w, "digits"))
            continue
        if variants & KEEP or any(v.rstrip(":") in KEEP for v in variants):
            continue
        visual = "".join(g.char for g in w)
        if re.fullmatch(r"[\d/.:,%\-₪()]+", visual) and not is_identifier(visual):
            continue  # amounts, dates, times, percentages stay
        out.append((w, "all"))
    return out


def substitute(pdf_path, out_path, names, seed):
    pdf = pikepdf.open(pdf_path)
    total = 0
    for page in pdf.pages:
        glyphs, streams = [], []
        walk(pdf, page.obj, [1, 0, 0, 1, 0, 0], glyphs, streams, set())
        words = words_of(glyphs)
        chosen = decide(words, names, None)
        # Replacement per glyph: (stream, op, elem, pos) -> new code
        edits = {}
        for word, how in chosen:
            for i, g in enumerate(word):
                cls = char_class(g.char)
                if cls is None or (how == "digits" and cls != "digit"):
                    continue
                pool = [c for c in g.font.by_class.get(cls, []) if c != g.char] if g.font else []
                if not pool:
                    continue
                # Same advance width (within 8%) where the subset allows,
                # so text drawn as one run keeps its length on the page.
                own = g.font.width(g.font.reverse.get(g.char, -1))
                close = [c for c in pool if abs(g.font.width(g.font.reverse[c]) - own) <= 0.08 * own]
                if close:
                    pool = close
                else:
                    best = min(abs(g.font.width(g.font.reverse[c]) - own) for c in pool)
                    pool = [c for c in pool if abs(g.font.width(g.font.reverse[c]) - own) == best]
                h = hashlib.sha256(f"{seed}|{g.char}|{i}|{g.x:.1f}|{g.y:.1f}".encode()).digest()
                new = pool[h[0] % len(pool)]
                edits[(g.stream, g.op, g.elem, g.pos)] = g.font.reverse[new]
        total += len(edits)
        for sid, (owner, ops) in enumerate(streams):
            touched = False
            new_ops = []
            for oi, (operands, op) in enumerate(ops):
                opname = str(op)
                if opname in ("Tj", "'", '"', "TJ") and any(
                    k[0] == sid and k[1] == oi for k in edits
                ):
                    touched = True
                    operands = list(operands)
                    if opname == "TJ":
                        arr = list(operands[-1])
                        for ei, el in enumerate(arr):
                            if isinstance(el, pikepdf.String):
                                arr[ei] = pikepdf.String(_patch(bytes(el), edits, sid, oi, ei))
                        operands[-1] = pikepdf.Array(arr)
                    else:
                        operands[-1] = pikepdf.String(
                            _patch(bytes(operands[-1]), edits, sid, oi, None)
                        )
                new_ops.append((operands, op))
            if touched:
                data = pikepdf.unparse_content_stream(new_ops)
                if isinstance(owner, pikepdf.Stream) and owner.get("/Subtype") == "/Form":
                    owner.write(data)
                else:
                    pikepdf.Page(owner).contents_coalesce()
                    pikepdf.Page(owner).obj.Contents.write(data)
        _grey_images(pdf, page.obj, set())
        if "/Annots" in page.obj:
            del page.obj["/Annots"]
    for key in list(pdf.docinfo.keys()):
        if key not in ("/Producer", "/CreationDate", "/ModDate"):
            del pdf.docinfo[key]
    if "/Metadata" in pdf.Root:
        del pdf.Root["/Metadata"]
    pdf.save(out_path)
    return total


def _patch(data, edits, sid, oi, ei):
    buf = bytearray(data)
    for pos in range(0, len(buf) - 1, 2):
        code = edits.get((sid, oi, ei, pos))
        if code is not None:
            buf[pos : pos + 2] = code.to_bytes(2, "big")
    return bytes(buf)


def _grey_images(pdf, owner, seen):
    resources = owner.get("/Resources", pikepdf.Dictionary())
    for name, xo in resources.get("/XObject", pikepdf.Dictionary()).items():
        if xo.objgen in seen:
            continue
        seen.add(xo.objgen)
        if xo.get("/Subtype") == "/Image":
            w, h = int(xo.Width), int(xo.Height)
            xo.write(zlib.compress(bytes([0xD8]) * (w * h)), filter=pikepdf.Name.FlateDecode)
            xo.ColorSpace = pikepdf.Name.DeviceGray
            xo.BitsPerComponent = 8
            for k in ("/SMask", "/Mask", "/Decode", "/DecodeParms", "/ImageMask", "/Intent"):
                if k in xo:
                    del xo[k]
        elif xo.get("/Subtype") == "/Form":
            _grey_images(pdf, xo, seen)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--names", help="file with private words (one per line)")
    ap.add_argument("--seed", default="pdf-inspector-he")
    args = ap.parse_args()
    names = set()
    if args.names:
        names = {l.strip() for l in open(args.names, encoding="utf-8") if l.strip()}
    count = substitute(args.src, args.dst, names, args.seed)
    print(f"{args.dst}: {count} glyphs replaced", file=sys.stderr)


if __name__ == "__main__":
    main()
