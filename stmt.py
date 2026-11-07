# Python port of Stmt.cs + extract.ps1 (SNB e-statement reader), for systems without Windows PowerShell.
# Kept line for line with the C# so it yields the same rows, and so stmt_import.py makes the same refs as import.ps1.
# Usage: python3 -I stmt.py OUTDIR oldest.pdf ... newest.pdf
# Writes rows_<a,b,...>.tsv and page1_<tag>.txt to OUTDIR (private data: OUTDIR must be outside this folder), prints the
# totals and balance check that extract.ps1 prints, and compares them with the controls on page 1.
import re
import sys
import unicodedata
import zlib
from decimal import Decimal
from pathlib import Path

# .NET char.IsWhiteSpace / String.Trim: Zs, Zl, Zp, U+0009-U+000D and U+0085
NET_WS = set('\t\n\x0b\x0c\r\x85 \xa0                　')
S = r'[\t\n\x0b\x0c\r\x85 \xa0]'  # .NET \s on Latin-1 text
UNMAPPED = 0


def trim(s):
    i, j = 0, len(s)
    while i < j and s[i] in NET_WS:
        i += 1
    while j > i and s[j - 1] in NET_WS:
        j -= 1
    return s[i:j]


def net_round(v, digits):  # Math.Round(double, int): scale, round half to even, unscale
    p = 10.0 ** digits
    return round(v * p) / p


def load(path):
    b = Path(path).read_bytes()
    t = b.decode('latin-1')
    objs = {}
    for m in re.finditer(r'(?<![0-9])([0-9]+)' + S + r'+([0-9]+)' + S + r'+obj\b', t):
        start = m.end()
        end = t.find('endobj', start)
        if end < 0:
            continue
        body = t[start:end]
        s = body.find('stream')
        if s >= 0:
            ds = start + s + 6
            if t[ds] == '\r':
                ds += 1
            if t[ds] == '\n':
                ds += 1
            de = t.find('endstream', ds)
            objs[int(m.group(1))] = (trim(body[:s]), b[ds:de])
        else:
            objs[int(m.group(1))] = (trim(body), None)
    return objs


def inflate(raw):  # Stmt.cs skips the 2-byte zlib header and reads raw deflate
    return zlib.decompressobj(-15).decompress(raw[2:])


def hex_to_str(h):
    return ''.join(chr(int(h[i:i + 4], 16)) for i in range(0, len(h) - 3, 4))


def parse_cmap(s):
    mp = {}
    for sec in re.finditer(r'beginbfrange(.*?)endbfrange', s, re.S):
        body = sec.group(1)
        for m in re.finditer(r'<([0-9a-fA-F]+)>' + S + r'*<([0-9a-fA-F]+)>' + S + r'*<([0-9a-fA-F]+)>', body):
            lo, hi, dst = int(m.group(1), 16), int(m.group(2), 16), m.group(3)
            if len(dst) == 4:
                u = int(dst, 16)
                for c in range(lo, hi + 1):
                    mp[c] = chr(u + c - lo)
            else:
                for c in range(lo, hi + 1):
                    mp[c] = hex_to_str(dst)
        for m in re.finditer(r'<([0-9a-fA-F]+)>' + S + r'*<([0-9a-fA-F]+)>' + S + r'*\[(.*?)\]', body, re.S):
            lo = int(m.group(1), 16)
            for i, v in enumerate(re.finditer(r'<([0-9a-fA-F]+)>', m.group(3))):
                mp[lo + i] = hex_to_str(v.group(1))
    for sec in re.finditer(r'beginbfchar(.*?)endbfchar', s, re.S):
        for m in re.finditer(r'<([0-9a-fA-F]+)>' + S + r'*<([0-9a-fA-F]+)>', sec.group(1)):
            mp[int(m.group(1), 16)] = hex_to_str(m.group(2))
    return mp


def page_objects(objs):
    root = -1
    for d, _ in objs.values():
        if re.search(r'/Type' + S + r'*/Catalog\b', d):
            root = int(re.search(r'/Pages' + S + r'+([0-9]+)' + S + r'+0' + S + r'+R', d).group(1))
    res = []

    def walk(n):
        d = objs[n][0]
        if re.search(r'/Type' + S + r'*/Pages\b', d):
            kids = re.search(r'/Kids' + S + r'*\[(.*?)\]', d, re.S).group(1)
            for k in re.finditer(r'([0-9]+)' + S + r'+0' + S + r'+R', kids):
                walk(int(k.group(1)))
        else:
            res.append(n)
    walk(root)
    return res


def is_arabic(c):
    o = ord(c)
    return 0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F or 0xFB50 <= o <= 0xFDFF or 0xFE70 <= o <= 0xFEFF


def letter_or_digit(c):  # .NET char.IsLetterOrDigit
    return unicodedata.category(c) in ('Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Nd')


def logical(s):
    """Text is stored in visual order, so Arabic runs read backwards. Rebuild logical order (Stmt.Logical)."""
    if not any(is_arabic(c) for c in s):
        return s
    parts, cur, cur_ltr = [], [], None
    for c in s:
        strong_ltr = letter_or_digit(c) and not is_arabic(c)
        strong_rtl = is_arabic(c)
        is_ltr = strong_ltr or (not strong_rtl and cur_ltr is True and c in '.,/:-*')
        if cur_ltr is None or is_ltr == cur_ltr:
            cur.append(c)
            cur_ltr = is_ltr
        else:
            parts.append(''.join(cur))
            cur = [c]
            cur_ltr = is_ltr
    if cur:
        parts.append(''.join(cur))
    parts.reverse()
    out = []
    for p in parts:
        out.append(p if any(letter_or_digit(c) and not is_arabic(c) for c in p) else p[::-1])
    return unicodedata.normalize('NFKC', ''.join(out))


def emit(raw, font, size, x, y, page, fonts, items):
    global UNMAPPED
    mp, sb = fonts[font], []
    for k in range(0, len(raw) - 1, 2):
        code = (ord(raw[k]) << 8) | ord(raw[k + 1])
        u = mp.get(code)
        if u is None:
            UNMAPPED += 1
            sb.append('�')
        else:
            sb.append(u)
    items.append({'page': page, 'x': x, 'y': y, 'size': size, 'font': font, 'text': ''.join(sb)})


def parse_content(c, page, fonts, items):
    i, n = 0, len(c)
    stack = []
    font, size, x, y, line_x, line_y, in_text = None, 0.0, 0.0, 0.0, 0.0, 0.0, False
    while i < n:
        ch = c[i]
        if ch in NET_WS:
            i += 1
            continue
        if ch == '(':
            sb, depth = [], 1
            i += 1
            while i < n and depth > 0:
                d = c[i]
                if d == '\\':
                    i += 1
                    e = c[i]
                    if e == 'n': sb.append('\n')
                    elif e == 'r': sb.append('\r')
                    elif e == 't': sb.append('\t')
                    elif e == 'b': sb.append('\b')
                    elif e == 'f': sb.append('\f')
                    elif '0' <= e <= '7':
                        v = k = 0
                        while k < 3 and i < n and '0' <= c[i] <= '7':
                            v = v * 8 + (ord(c[i]) - 48)
                            i += 1
                            k += 1
                        sb.append(chr(v))
                        continue
                    elif e == '\r':
                        if c[i + 1] == '\n':
                            i += 1
                    elif e == '\n':
                        pass
                    else:
                        sb.append(e)
                    i += 1
                    continue
                if d == '(':
                    depth += 1
                elif d == ')':
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                sb.append(d)
                i += 1
            stack.append('S' + ''.join(sb))
            continue
        if ch == '<' and i + 1 < n and c[i + 1] != '<':
            e = c.find('>', i)
            hx = c[i + 1:e]
            stack.append('S' + ''.join(chr(int(hx[k:k + 2], 16)) for k in range(0, len(hx) - 1, 2)))
            i = e + 1
            continue
        if ch in '[]':
            stack.append(ch)
            i += 1
            continue
        if ch in '<>':
            i += 2
            continue
        st = i
        while i < n and c[i] not in NET_WS and c[i] not in '([]<>':
            if i > st and c[i] == '/':
                break
            i += 1
        if i == st:
            i += 1
            continue
        tok = c[st:i]
        if tok[0].isalpha() or tok[0] in '\'"*':
            if tok == 'BT':
                in_text, x, y, line_x, line_y = True, 0.0, 0.0, 0.0, 0.0
            elif tok == 'ET':
                in_text = False
            elif in_text:
                num = lambda k: float(stack[len(stack) - k])  # noqa: E731
                if tok == 'Tf':
                    font, size = stack[len(stack) - 2][1:], num(1)
                elif tok == 'Tm':
                    x = line_x = num(2)
                    y = line_y = num(1)
                elif tok in ('Td', 'TD'):
                    line_x += num(2)
                    line_y += num(1)
                    x, y = line_x, line_y
                elif tok == 'Tj':
                    emit(stack[-1][1:], font, size, x, y, page, fonts, items)
                elif tok == 'TJ':
                    k0 = len(stack) - 1 - stack[::-1].index('[')
                    emit(''.join(s[1:] for s in stack[k0:] if s and s[0] == 'S'), font, size, x, y, page, fonts, items)
            stack.clear()
        else:
            stack.append(tok)


def items_of(path):
    objs = load(path)
    items, font_maps = [], {}
    for page_no, pn in enumerate(page_objects(objs), 1):
        pd = objs[pn][0]
        fonts = {}
        fd = re.search(r'/Font' + S + r'*<<(.*?)>>', pd, re.S)
        for f in re.finditer(r'/(F[0-9]+)' + S + r'+([0-9]+)' + S + r'+0' + S + r'+R', fd.group(1) if fd else ''):
            fnum = int(f.group(2))
            if fnum not in font_maps:
                tu = re.search(r'/ToUnicode' + S + r'+([0-9]+)' + S + r'+0' + S + r'+R', objs[fnum][0])
                font_maps[fnum] = parse_cmap(inflate(objs[int(tu.group(1))][1]).decode('latin-1')) if tu else {}
            fonts[f.group(1)] = font_maps[fnum]
        cn = int(re.search(r'/Contents' + S + r'+([0-9]+)' + S + r'+0' + S + r'+R', pd).group(1))
        parse_content(inflate(objs[cn][1]).decode('latin-1'), page_no, fonts, items)
    return items


def column_of(x):  # column edges from the table rules drawn in the PDF
    if x < 98.81: return 'balance'
    if x < 157.01: return 'debit'
    if x < 215.63: return 'credit'
    if x < 380.1: return 'desc'
    if x < 508.35: return 'type'
    return 'date'


def rows_of(items):
    rows, last = [], None
    for pg in sorted({it['page'] for it in items}):
        if pg == 1:
            continue
        tbl = [it for it in items if it['page'] == pg and 62 < it['y'] < 672 and len(trim(it['text'])) > 0]
        dates = sorted((it for it in tbl if column_of(it['x']) == 'date' and re.fullmatch(r'\d{2}/\d{2}/\d{4}', trim(it['text']))), key=lambda it: -it['y'])
        page_rows = []
        for d in dates:
            r = {'page': pg, 'date': trim(d['text']), 'time': None, 'type': None, 'desc': [], 'credit': '', 'debit': '', 'balance': '', 'date_y': d['y']}
            page_rows.append(r)
            rows.append(r)
        for it in sorted(tbl, key=lambda a: (-net_round(a['y'], 1), a['x'])):
            target = None
            for r in page_rows:
                if it['y'] <= r['date_y'] + 4:
                    target = r
            if target is None:
                target = last
            if target is None:
                continue
            col, txt = column_of(it['x']), trim(it['text'])
            if col == 'date':
                if txt != target['date']:
                    target['time'] = txt
            elif col == 'type':
                target['type'] = ('' if target['type'] is None else target['type'] + ' ') + logical(txt)
            elif col == 'desc':
                target['desc'].append(logical(txt))
            elif col == 'credit':
                target['credit'] += txt
            elif col == 'debit':
                target['debit'] += txt
            elif col == 'balance':
                target['balance'] += txt
        if page_rows:
            last = page_rows[-1]
    return rows


def tsv(rows):
    return ''.join('\t'.join([str(r['page']), r['date'], r['time'] or '', r['type'] or '', r['credit'], r['debit'], r['balance'], ' | '.join(r['desc'])]) + '\r\n' for r in rows)


def page_one(items):
    sel = [it for it in items if it['page'] == 1 and len(trim(it['text'])) > 0 and it['y'] > 400]
    sel.sort(key=lambda a: (-net_round(a['y'], 0), a['x']))
    return ''.join(f"{it['x']:.0f},{it['y']:.0f}: {trim(it['text'])}\r\n" for it in sel)


def to_num(v):
    return Decimal(0) if v is None or not trim(v) else Decimal(v.replace(',', ''))


def check(path, tag, outdir):
    global UNMAPPED
    UNMAPPED = 0
    items = items_of(path)
    rows = rows_of(items)
    (outdir / f'rows_{tag}.tsv').write_text(tsv(rows), encoding='utf-8', newline='')
    (outdir / f'page1_{tag}.txt').write_text(page_one(items), encoding='utf-8', newline='')
    print(f'[{tag}] items={len(items)} rows={len(rows)} unmapped={UNMAPPED}')
    deb = cred = Decimal(0)
    deb_n = cred_n = bad = 0
    prev = None
    for i, r in enumerate(rows):
        d, c, b = to_num(r['debit']), to_num(r['credit']), to_num(r['balance'])
        deb += d
        cred += c
        deb_n += d != 0
        cred_n += c != 0
        if prev is not None and prev - d + c != b:
            bad += 1
            print(f"   balance break at row {i} page {r['page']}")
        prev = b
    print(f"   debit total={deb} count={deb_n} | credit total={cred} count={cred_n} | end balance={prev} | first={rows[0]['date']} last={rows[-1]['date']} | breaks={bad}")
    first = rows[0]
    start = to_num(first['balance']) + to_num(first['debit']) - to_num(first['credit'])
    print('   page 1: ' + page_one_check(items, {'start': start, 'debit': deb, 'credit': cred, 'end': prev, 'debits': deb_n, 'credits': cred_n}))


def page_one_check(items, got):
    """Page 1 controls (start balance, debit and credit totals and counts, end balance) against the rows."""
    p1 = [it for it in items if it['page'] == 1 and trim(it['text'])]

    def at(x, y, pat):
        c = [trim(it['text']) for it in p1 if abs(it['x'] - x) < 30 and abs(it['y'] - y) < 6 and re.fullmatch(pat, trim(it['text']))]
        return c[0] if len(c) == 1 else None
    am, n = r'-?[\d,]+\.\d{2}', r'\d{1,5}'
    want = {'start': at(479, 415, am), 'debit': at(209, 415, am), 'credit': at(332, 415, am), 'end': at(76, 414, am), 'debits': at(221, 390, n), 'credits': at(348, 390, n)}
    if None in want.values():
        return 'controls not found where expected (layout changed?): compare by hand with page1_*.txt'
    want = {k: (int(v) if k in ('debits', 'credits') else to_num(v)) for k, v in want.items()}
    bad = [f'{k} {want[k]} vs rows {got[k]}' for k in want if want[k] != got[k]]
    return 'MISMATCH ' + '; '.join(bad) if bad else f"OK (start {want['start']}, {want['debits']} debits {want['debit']}, {want['credits']} credits {want['credit']}, end {want['end']})"


if __name__ == '__main__':
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for n, f in enumerate(sys.argv[2:]):
        check(f, chr(97 + n), out)
