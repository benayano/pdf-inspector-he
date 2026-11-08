"""Make a "misread" test PDF: change one digit of one printed cell, in place.

    python he/tools/misread_pdf.py in.pdf out.pdf <cell text> <new digit>
    python he/tools/misread_pdf.py priority-1p.pdf priority-1p.misread-row11.pdf 27.35 3

The repair layer (he/repair.mjs) needs invoices where a few rows do not close
for the reason they fail in life: a number read wrong. This rewrites the FIRST
digit of the LAST show operation whose decoded text is exactly <cell text>
(27.35 -> 37.35), in the page's Form XObject (Winnovative/Priority invoices
draw the whole page inside one form, with Identity-H glyph ids and a
ToUnicode CMap). Geometry, fonts and every other cell stay as they were.
Only for anonymized fixtures. Needs pypdf.
"""
import pypdf, re, sys
src, dst, target, new_last = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
r = pypdf.PdfReader(src)
form = list(r.pages[0]['/Resources']['/XObject'].values())[0].get_object()
fonts = form['/Resources']['/Font']
def cmap_of(font):
    tu = font.get_object().get('/ToUnicode')
    data = tu.get_object().get_data().decode('latin1')
    m = {}
    for block in re.findall(r'beginbfchar(.*?)endbfchar', data, re.S):
        for a,b in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', block):
            m[int(a,16)] = bytes.fromhex(b).decode('utf-16-be')
    for block in re.findall(r'beginbfrange(.*?)endbfrange', data, re.S):
        for a,b,c in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', block):
            s,e,base=int(a,16),int(b,16),int(c,16)
            for g in range(s,e+1): m[g]=chr(base+g-s)
    return m
maps = {name: cmap_of(f) for name,f in fonts.items()}
data = form.get_data()
cur=None; hits=[]
for m in re.finditer(rb'(/[^\s/<\[]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]+)>\s*Tj', data):
    if m.group(1): cur = m.group(1).decode(); continue
    hexs = m.group(2).decode(); gids=[int(hexs[i:i+4],16) for i in range(0,len(hexs),4)]
    text=''.join(maps.get(cur,{}).get(g,'?') for g in gids)
    if text.strip()==target: hits.append((m.start(2), m.end(2), gids, cur, text))
print('hits', [(h[3], h[4]) for h in hits])
start,end,gids,font,text = hits[-1]
rev = {v:k for k,v in maps[font].items()}
chars=[maps[font][g] for g in gids]
i = min(k for k,c in enumerate(chars) if c.isdigit())
gids[i]=rev[new_last]
data2 = data[:start]+''.join(f'{g:04x}' for g in gids).encode()+data[end:]
w = pypdf.PdfWriter(clone_from=src)
list(w.pages[0]['/Resources']['/XObject'].values())[0].get_object().set_data(data2)
w.write(dst); print('written', dst)
