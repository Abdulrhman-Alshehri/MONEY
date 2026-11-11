# Python port of import.ps1, for systems without Windows PowerShell. Kept rule for rule with import.ps1 (same patterns
# in the same order) so rows, categories and refs come out the same: change both together.
# PowerShell's -match, -notmatch and -eq on strings ignore case; that is kept with re.I and casefold().
# Env, as import.ps1: SNB_WORK (stmt.py output folder), SEQ_START (seq after which the new rows go), and to really send:
# SMS_URL, CONFIRM_IMPORT=yes, and APP_TOKEN unless a proxy adds the x-api-key header. Each statement is sent on its own.
# Usage: SNB_WORK=/private/stmt SEQ_START=432 python3 -I stmt_import.py
import json
import re
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

NET_WS = set('\t\n\x0b\x0c\r\x85 \xa0                　')


def trim(s):
    i, j = 0, len(s)
    while i < j and s[i] in NET_WS:
        i += 1
    while j > i and s[j - 1] in NET_WS:
        j -= 1
    return s[i:j]


def match(s, pat):  # PowerShell -match: case-insensitive, $null never matches
    return re.search(pat, s, re.I) if s is not None else None


def eq(a, b):  # PowerShell -eq on strings
    return a is not None and a.casefold() == b.casefold()


MCC_CAT = {
    '5814': 'Food & Cafes', '5812': 'Food & Cafes', '5411': 'Groceries', '5499': 'Groceries', '5441': 'Groceries', '5331': 'Groceries',
    '5541': 'Fuel', '4121': 'Transport', '4722': 'Travel', '7011': 'Travel', '5815': 'Subscriptions', '5818': 'Subscriptions', '7372': 'Subscriptions',
    '4814': 'Bills & Telecom', '4816': 'Bills & Telecom', '6012': 'Wallets & Finance', '6513': 'Rent & Housing', '5912': 'Health',
    '5947': 'Shopping', '5661': 'Shopping', '5651': 'Shopping', '5942': 'Shopping', '5999': 'Shopping', '5199': 'Shopping', '5399': 'Shopping',
    '7832': 'Entertainment', '7997': 'Entertainment', '7941': 'Entertainment', '7210': 'Personal Care', '7230': 'Personal Care',
}
MCC_NAME = {'5814': 'Food', '5812': 'Restaurant', '5411': 'Supermarket', '4814': 'Telecom', '4816': 'Internet', '6012': 'Wallet/Finance',
            '7372': 'Software', '7832': 'Cinema', '6513': 'Rent', '5399': 'Shopping', '5331': 'Shopping', '4121': 'Taxi'}


def build(work, seq):
    seen, rows = set(), []
    prev_date, prev_min = None, -1
    for f in sorted(p.name for p in Path(work).glob('rows_*.tsv')):
        text = (Path(work) / f).read_text(encoding='utf-8')
        lines = re.split(r'\r\n|\r|\n', text)
        if lines and lines[-1] == '':
            lines.pop()
        for line in lines:
            if not trim(line):
                continue
            c = line.split('\t')
            date_s, time_s, typ = c[1], c[2], c[3]
            cr, db, bal = c[4].replace(',', ''), c[5].replace(',', ''), c[6].replace(',', '')
            d = [trim(x) for x in c[7].split('|')] if len(c) > 7 else []
            ref = f'stmt:{date_s} {time_s} {db} {cr} {bal}'
            if ref in seen:
                continue
            seen.add(ref)
            seq += 1
            mcc = None
            for x in d:
                m = match(x, r'^MCC-(\d+)')
                if m:
                    mcc = m.group(1)
            city, i = None, -1
            for q in range(len(d)):
                if match(d[q], r'^MC\d{4}$'):
                    i = q
                    break
            if i >= 0 and i + 1 < len(d):
                n = d[i + 1]
                if n == '1.000000' and i + 2 < len(d):
                    n = d[i + 2]
                if not match(n, r'^(Charges|MCC|CITY|\d)'):
                    city = n
            first = d[0] if d else None
            amt = db if db else cr
            id_line = -1
            for k in range(len(d)):
                if match(d[k], 'رقم الهوية'):
                    id_line = k
            at = lambda k: d[k] if 0 <= k < len(d) else None  # noqa: E731  (PowerShell gives $null past the end)
            kind, chan, cat, m_ = 'purchase', 'pos', None, None
            if match(typ, '^شراء انترنت|عملية شراء|خصم'):
                chan = 'online'
            if match(typ, 'دولي|الخليج'):
                chan = 'intl'
            if match(typ, 'إعادة|عكس'):
                kind = 'refund'
            elif match(typ, 'إيداع رواتب|إيداع راتب|حساب المواطن|مكافأة طلاب|من صاحب العمل') or match(typ, '^حوالة محلية واردة'):
                kind, chan, cat = 'income', 'bank', 'Income'
                # إيداع راتب's second line is a reference number, not the payer
                m_ = 'Citizen Account' if match(typ, 'المواطن') else 'Salary' if match(typ, 'إيداع راتب') else at(1)
            elif match(typ, 'إيداع نقدي'):
                kind, chan, cat, m_ = 'cash_in', 'atm', 'Cash deposit', 'ATM cash deposit'
            elif match(typ, 'سحب نقدي'):
                chan, cat, m_ = 'atm', 'Cash withdrawal', 'ATM cash withdrawal'
            elif match(typ, 'سداد'):
                chan, m_ = 'bank', first
            elif match(typ, 'رسوم'):
                kind, chan, cat, m_ = 'fee', 'bank', 'Fees', 'Transfer fee'
            elif match(typ, 'ضريبة'):
                kind, chan, cat, m_ = 'fee', 'bank', 'Fees', 'VAT on fee'
            elif match(typ, '^حوالة صادرة'):
                chan, cat, m_ = 'bank', 'Government', 'Traffic fine'
            elif match(typ, 'وارد') and match(first, '^عكس.*نقاط بيع'):
                kind, m_ = 'refund', 'Card refund'
                if match(first, 'دولي'):
                    chan = 'intl'
            elif match(typ, 'واردة|وارد'):
                kind, chan, cat = 'transfer_in', 'transfer', 'Transfers'
                m_ = at(id_line + 1) if id_line >= 0 else at(2)
            elif match(typ, 'صادرة|صادر'):
                kind, chan, cat = 'transfer_out', 'transfer', 'Transfers'
                m_ = at(id_line + 1) if id_line >= 0 else first
            m_ = re.sub('^السيد ', '', m_, flags=re.I) if m_ else None
            if not m_:
                mm = None
                if match(line, 'PLAYSTATION'):
                    m_, cat = 'PlayStation', 'Entertainment'
                elif (mm := match(first, '^(.*),INTL ATM')):
                    m_ = f'{mm.group(1)} (intl)'
                elif match(first, '^riyadh,bolt'):
                    m_ = 'Bolt'
                elif (mm := match(first, '^,(.+)')):
                    m_ = mm.group(1)
                elif (mm := match(first, '^([^,]+),')):
                    m_ = trim(mm.group(1))
                elif kind == 'refund':
                    m_ = 'Noon' if match(first, '^noon$') else first
                elif mcc == '4121' and eq(city, 'Jebah'):
                    m_ = 'Jeeny'
                elif mcc == '4121' and match(line, 'MCF'):
                    m_ = 'Bolt'
                elif eq(city, 'MYSR q Public'):
                    m_ = city
                elif chan == 'intl':
                    m_ = f"{city or ''} (intl)"
                else:
                    label = MCC_NAME.get(mcc) if mcc is not None else None
                    if not label:
                        label = f"MCC {mcc or ''}"
                    m_ = f'Online: {label}'
            if not cat:
                if match(m_, 'Jeeny|Bolt'):
                    cat = 'Transport'
                elif match(m_, '^Noon$'):
                    cat = 'Groceries'
                elif mcc and MCC_CAT.get(mcc):
                    cat = MCC_CAT[mcc]
                else:
                    cat = 'Uncategorized'
            # Bank lists rows in posting order: an after-midnight purchase can carry the previous date.
            dd, mo, yy = (int(x) for x in date_s.split('/'))
            dt = date(yy, mo, dd)
            th, tm = (int(x) for x in time_s.split(':'))
            mins = th * 60 + tm
            real = dt
            if kind == 'purchase' and date_s == prev_date and mins < prev_min and th < 6:
                real = dt + timedelta(days=1)
            prev_date, prev_min = date_s, mins
            rows.append({'amount': Decimal(amt), 'merchant': m_, 'type': chan, 'kind': kind, 'category': cat, 'city': city, 'mcc': mcc,
                         'balance': Decimal(bal), 'source': 'statement', 'ref': ref, 'seq': seq,
                         'occurred_at': real.strftime('%Y-%m-%d') + f'T{time_s}:00+03:00', '_file': f, '_type': typ,
                         '_credit': bool(cr), '_debit': Decimal(db or 0), '_cr': Decimal(cr or 0)})
    return rows


KEYS = ['amount', 'merchant', 'type', 'kind', 'category', 'city', 'mcc', 'balance', 'source', 'ref', 'seq', 'occurred_at']


def to_json(rows):  # amounts go out as written ("12.50"), as ConvertTo-Json does with [decimal]
    val = lambda k, v: str(v) if isinstance(v, Decimal) else json.dumps(v, ensure_ascii=False)  # noqa: E731
    return '[' + ','.join('{' + ','.join(f'"{k}":{val(k, r[k])}' for k in KEYS) + '}' for r in rows) + ']'


def send(url, body, token):
    import urllib.request
    headers = {'content-type': 'application/json; charset=utf-8'}
    if token:
        headers['x-api-key'] = token
    req = urllib.request.Request(url + '?action=import', data=body.encode('utf-8'), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode('utf-8')


if __name__ == '__main__':
    import os
    work = os.environ.get('SNB_WORK') or sys.exit('Set SNB_WORK')
    rows = build(work, int(os.environ.get('SEQ_START', '0')))
    print(f'rows: {len(rows)}')
    groups = {}
    for r in rows:
        groups.setdefault(r['kind'], []).append(r)
    for k, g in groups.items():
        print(f"{k}: {len(g)} = {sum(r['amount'] for r in g)}")
    print('--- spend by category')
    cats = {}
    for r in rows:
        if r['kind'] in ('purchase', 'fee'):
            e = cats.setdefault(r['category'], [0, Decimal(0)])
            e[0] += 1
            e[1] += r['amount']
    for c, (n, s) in sorted(cats.items(), key=lambda kv: -kv[1][1]):
        print(f'{c}: {n} = {s}')
    print('--- bank types (check for new ones, especially credits)')
    types = {}
    for r in rows:
        k = (r['_type'], r['kind'], 'credit' if r['_credit'] else 'debit')
        types[k] = types.get(k, 0) + 1
    for (t, k, side), n in sorted(types.items(), key=lambda kv: -kv[1]):
        print(f'{n:5} {side:6} {k:12} {t}')
    if os.environ.get('CONFIRM_IMPORT') != 'yes':
        sys.exit('Dry run: nothing sent')
    url = os.environ.get('SMS_URL') or sys.exit('Set SMS_URL')
    for f in sorted({r['_file'] for r in rows}):
        part = [r for r in rows if r['_file'] == f]
        print(f, len(part), send(url, to_json(part), os.environ.get('APP_TOKEN')))
