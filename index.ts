import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-api-key', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const norm = (s: string) => s
  .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
  .replace(/[\s​-‏‪-‮﻿]/g, '');

const merchantKey = (m: string | null) => (m ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const KEYWORDS: [RegExp, string][] = [
  [/jeeny|bolt|uber|careem|taxi/i, 'Transport'],
  [/noon|panda|tamimi|othaim|lulu|danube/i, 'Groceries'],
  [/hunger|jahez|mrsool|toyo|keeta|ninja/i, 'Food & Cafes'],
  [/stc|mobily|zain/i, 'Bills & Telecom'],
  [/netflix|spotify|apple|google|playstation/i, 'Subscriptions'],
];

function parse(t: string) {
  const text = t.replace(/[​-‏‪-‮﻿]/g, '').replace(/\s+/g, ' ').trim();
  if (/otp|\bcode\b|رمز|كلمة المرور|التحقق/i.test(text)) return null; // never store login codes
  const am = text.match(/SAR\s*([\d,]+(?:\.\d+)?)/i) ?? text.match(/([\d,]+(?:\.\d+)?)\s*SAR/i);
  const amount = am ? parseFloat(am[1].replace(/,/g, '')) : null;
  let type = 'other', kind = 'unknown', merchant: string | null = null;
  const isIn = /وارد/.test(text);
  const head = text.split(/SAR|\d/)[0]; // the message type: the words before the first number or SAR
  if (/رواتب|راتب/.test(head) && !/صادر/.test(head)) {
    // A salary paid as a transfer. Only the message type is checked, so a person named Rateb stays a transfer.
    type = 'bank'; kind = 'income'; merchant = 'Salary';
  } else if (/حوالة|تحويل/.test(text)) {
    type = 'transfer';
    kind = isIn ? 'transfer_in' : 'transfer_out';
    merchant = text.match(/\d{4}\*?\s*([^\d*]+?)\s*\d{2}\/\d{2}\/\d{2}/)?.[1]?.trim() ?? null;
  } else if (/رواتب|راتب/.test(text)) {
    type = 'bank'; kind = 'income'; merchant = 'Salary';
  } else if (/إيداع/.test(text)) {
    type = 'atm'; kind = 'cash_in'; merchant = 'Cash deposit';
  } else if (/إعادة|استرداد|عكس|مرتجع/.test(text)) {
    type = 'pos'; kind = 'refund';
    merchant = text.match(/من\s+(?![*\d])(.+?)\s*(?:مدى|في|$)/)?.[1]?.trim() ?? null;
  } else if (/شراء|خصم|سداد/.test(text)) {
    type = text.includes('POS') ? 'pos' : /دولي/.test(text) ? 'intl' : 'online';
    kind = 'purchase';
    merchant = text.match(/من\s+(?![*\d])(.+?)\s*مدى/)?.[1]?.trim() ?? null;
  }
  let occurred_at: string | null = null;
  const d = text.match(/(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{2})/);
  if (d) occurred_at = `20${d[5]}-${d[4]}-${d[3]}T${d[1]}:${d[2]}:00+03:00`;
  else {
    const e = text.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    if (e) occurred_at = `20${e[3]}-${e[2]}-${e[1]}T${e[4]}:${e[5]}:00+03:00`;
  }
  return { amount, type, kind, merchant, occurred_at };
}

async function categorize(kind: string, merchant: string | null) {
  if (kind === 'transfer_in') return 'Transfers';
  if (kind === 'income') return 'Income';
  if (kind === 'cash_in') return 'Cash deposit';
  // User rules come first, so a person marked once (the landlord as Rent & Housing) stays that way.
  if (merchant) {
    const { data } = await db.from('merchant_rules').select('category').eq('merchant_key', merchantKey(merchant)).maybeSingle();
    if (data) return data.category;
  }
  if (kind === 'transfer_out') return 'Transfers';
  for (const [re, c] of KEYWORDS) if (merchant && re.test(merchant)) return c;
  return 'Uncategorized';
}

const PAGE = 1000; // Supabase returns at most 1000 rows per request unless the project setting says otherwise

// Reads every page of a query. `query` must build a fresh query with a stable order each call.
// Pages advance by the rows actually received, so a lower server cap still reads everything.
// deno-lint-ignore no-explicit-any
async function readAll(query: () => any): Promise<{ data: any[]; error: { message: string } | null }> {
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  for (let i = 0; i < 1000; i++) {
    const { data, error } = await query().range(rows.length, rows.length + PAGE - 1);
    if (error) return { data: rows, error };
    if (!data?.length) return { data: rows, error: null };
    rows.push(...data);
  }
  return { data: rows, error: { message: 'too many rows' } };
}

const RIYADH = 3 * 3600e3; // Riyadh is UTC+3 all year
const DAY = 864e5;
const INCOMING = ['transfer_in', 'income', 'cash_in'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const num = (v: unknown) => Number(v) || 0;
const round2 = (n: number) => Math.round(n * 100) / 100;
const whole = (n: number) => Math.round(n).toLocaleString('en-US');
const exact = (n: number) => (n % 1 ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : whole(n));

// The same rules as spend() in index.html, which is the definition of spending: keep the two identical.
// deno-lint-ignore no-explicit-any
function counts(p: any) {
  if (p.excluded) return 0;
  if (p.kind === 'purchase' || p.kind === 'fee') return num(p.amount);
  if (p.kind === 'refund') return -num(p.amount);
  if (p.kind === 'transfer_out' && p.category !== 'Transfers' && p.category !== 'Savings') return num(p.amount);
  return 0;
}
// deno-lint-ignore no-explicit-any
const sentToPeople = (p: any) => (!p.excluded && p.kind === 'transfer_out' && p.category === 'Transfers' ? num(p.amount) : 0);
// deno-lint-ignore no-explicit-any
const sameMerchant = (rows: any[], key: string) => rows.filter((p) => merchantKey(p.merchant) === key && !INCOMING.includes(p.kind)).map((p) => p.id);
// Runs of 5+ days with no payments at all that touch [from, to] (day numbers), clipped to it: totals there are incomplete.
// Each run is measured in full, so the 4 empty days that start a month count when they end a longer gap.
// The same rules as gaps() and incomplete() in index.html. Here `days` begins with the day before the rows that were
// read, so a run already going on then (or the time before the first payment) still counts as a gap.
function gaps(days: number[], from: number, to: number, today: number) {
  const out: [number, number][] = [];
  for (let i = 1; i <= days.length; i++) {
    const a = days[i - 1] + 1, b = i < days.length ? days[i] - 1 : today;
    if (b - a >= 4 && b >= from && a <= to) out.push([Math.max(a, from), Math.min(b, to)]);
  }
  return out;
}
const isoDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

// This month so far against last month by the same day, in Riyadh time. Feeds the widget, Siri and the SMS notice.
async function summarize() {
  const now = new Date(Date.now() + RIYADH), y = now.getUTCFullYear(), m = now.getUTCMonth(), day = now.getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, 1)), ly = last.getUTCFullYear(), lm = last.getUTCMonth();
  const sameDay = Math.min(day, new Date(Date.UTC(ly, lm + 1, 0)).getUTCDate());
  const today = Math.floor(now.getTime() / DAY), thisStart = Date.UTC(y, m, 1) / DAY, lastStart = Date.UTC(ly, lm, 1) / DAY;
  const readFrom = lastStart - 5; // 5 days early, so a gap that started before last month is seen at full length
  const from = new Date(readFrom * DAY - RIYADH).toISOString();
  const { data, error } = await readAll(() => db.from('payments').select('id,amount,kind,category,excluded,occurred_at,created_at')
    .or(`occurred_at.gte."${from}",and(occurred_at.is.null,created_at.gte."${from}")`).order('created_at').order('id'));
  if (error) throw new Error(error.message);
  let spent = 0, sent = 0, lastSame = 0, lastTotal = 0, lastSeen = false;
  const seen = new Set<number>(), byCat = new Map<string, number>();
  for (const p of data) {
    const t = new Date(p.occurred_at ?? p.created_at).getTime() + RIYADH, d = new Date(t), py = d.getUTCFullYear(), pm = d.getUTCMonth(), pd = d.getUTCDate();
    if (t >= readFrom * DAY) seen.add(Math.floor(t / DAY));
    if (py === y && pm === m && pd <= day) {
      const v = counts(p);
      spent += v; sent += sentToPeople(p);
      if (v) byCat.set(p.category, (byCat.get(p.category) || 0) + v);
    } else if (py === ly && pm === lm) { lastTotal += counts(p); if (pd <= sameDay) lastSame += counts(p); lastSeen = true; }
  }
  const days = [readFrom - 1, ...[...seen].sort((a, b) => a - b)], lastDay = days[days.length - 1];
  const stale = Math.max(0, today - lastDay), end = Math.min(today, lastDay);
  const missing = gaps(days, lastStart, end, today); // as the dashboard's warning: last month's start up to the latest payment
  const fair = lastSeen && stale < 3 && !gaps(days, thisStart, end, today).length && !gaps(days, lastStart, lastStart + sameDay - 1, today).length;
  const diff = spent - lastSame;
  let text = `You've spent ${whole(spent)} riyals this month`;
  if (stale >= 3) text += `, but no payments have arrived for ${stale} days. Check the SMS Shortcut.`;
  else if (!fair) text += missing.length ? `. Some days have no data, so there's no comparison with ${MONTHS[lm]}.` : '.';
  else if (Math.abs(diff) < Math.max(100, lastSame * 0.05)) text += `, about the same as ${MONTHS[lm]} by this day.`;
  else text += `, ${whole(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than ${MONTHS[lm]} by this day.`;
  return {
    month: `${y}-${String(m + 1).padStart(2, '0')}`, day, days_in_month: new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
    spent: round2(spent), sent: round2(sent), last_month: MONTHS[lm], last_same_day: round2(lastSame), last_total: round2(lastTotal),
    comparable: fair, stale_days: stale, gaps: missing.map(([a, b]) => [isoDay(a), isoDay(b)]),
    // Biggest categories this month, as totals() in index.html: refunds already taken off
    top: [...byCat].filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, v]) => ({ category, amount: round2(v) })),
    text,
  };
}

// One line for the Shortcut's notification after each SMS.
// deno-lint-ignore no-explicit-any
function notice(p: any, category: string, s: any) {
  const a = p.amount == null ? '?' : exact(num(p.amount)), who = p.merchant ?? 'someone';
  const month = s ? ` · ${whole(s.spent)} spent this month` : '';
  switch (p.kind) {
    case 'purchase': case 'fee': return `${p.merchant ?? 'Payment'} ${a} · ${category}${month}`;
    case 'refund': return `Refund ${a} from ${p.merchant ?? 'a shop'}${month}`;
    case 'income': return `Salary in: ${a}`;
    case 'cash_in': return `Cash deposit: ${a}`;
    case 'transfer_in': return `Received ${a} from ${who}`;
    case 'transfer_out': return category === 'Savings' ? `Moved ${a} to savings` : category === 'Transfers' ? `Sent ${a} to ${who} · not counted as spending` : `${who} ${a} · ${category}${month}`;
    default: return 'Saved, but not recognised. Check Review in the app.';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const key = norm(Deno.env.get('APP_TOKEN') ?? '');
  if (!key || norm(req.headers.get('x-api-key') ?? '') !== key) return json({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const id = url.searchParams.get('id');

  if (req.method === 'GET' && action === 'summary') {
    try { return json(await summarize()); } catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  if (req.method === 'GET') {
    // Insert order, so a payment that arrives during the read lands on the last page instead of shifting the others
    const { data, error } = await readAll(() => db.from('payments').select('id,amount,currency,merchant,type,kind,category,city,mcc,balance,source,seq,note,excluded,occurred_at,created_at').order('created_at').order('id'));
    return error ? json({ error: error.message }, 500) : json(data);
  }

  if (req.method === 'PATCH' && id) {
    const b = await req.json();
    const patch: Record<string, unknown> = {};
    for (const k of ['category', 'note', 'excluded']) if (k in b) patch[k] = b[k];
    const { data: row, error: e1 } = await db.from('payments').select('merchant,kind').eq('id', id).single();
    if (e1) return json({ error: e1.message }, 404);
    if (b.apply_to_merchant && b.category && row.merchant) {
      const key = merchantKey(row.merchant);
      await db.from('merchant_rules').upsert({ merchant_key: key, category: b.category, updated_at: new Date().toISOString() });
      // Every payment with this merchant, whatever the capitals or spacing. Money received keeps its own category.
      const { data: all, error: e2 } = await readAll(() => db.from('payments').select('id,merchant,kind').not('merchant', 'is', null).order('created_at').order('id'));
      if (e2) return json({ error: e2.message }, 500);
      const ids = [...new Set([id, ...sameMerchant(all, key)])];
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await db.from('payments').update({ category: b.category }).in('id', ids.slice(i, i + 200));
        if (error) return json({ error: error.message }, 500);
      }
      if ('note' in b || 'excluded' in b) { const { category: _c, ...rest } = patch; await db.from('payments').update(rest).eq('id', id); }
      return json({ ok: true, updated: ids.length });
    }
    const { error } = await db.from('payments').update(patch).eq('id', id);
    return error ? json({ error: error.message }, 500) : json({ ok: true, updated: 1 });
  }

  if (req.method === 'DELETE' && id) {
    const { error } = await db.from('payments').delete().eq('id', id);
    return error ? json({ error: error.message }, 500) : json({ ok: true });
  }

  if (req.method === 'POST' && action === 'import') {
    const rows = await req.json();
    const { data: have, error: e } = await readAll(() => db.from('payments').select('ref').not('ref', 'is', null).order('ref'));
    if (e) return json({ error: e.message }, 500);
    const seen = new Set((have ?? []).map((r) => r.ref));
    const fresh = rows.filter((r: { ref: string }) => !seen.has(r.ref));
    // Your rules win over the statement's guess, as they do for SMS. Money received keeps its own category.
    const { data: rules, error: e3 } = await readAll(() => db.from('merchant_rules').select('merchant_key,category').order('merchant_key'));
    if (e3) return json({ error: e3.message }, 500);
    const rule = new Map(rules.map((r) => [r.merchant_key, r.category]));
    let ruled = 0;
    for (const r of fresh) {
      const c = r.merchant ? rule.get(merchantKey(r.merchant)) : undefined;
      if (c && !INCOMING.includes(r.kind) && r.category !== c) { r.category = c; ruled++; }
    }
    if (fresh.length) { const { error } = await db.from('payments').insert(fresh); if (error) return json({ error: error.message }, 500); }
    return json({ ok: true, received: rows.length, inserted: fresh.length, categorized_by_rules: ruled });
  }

  if (req.method === 'POST') {
    const body = await req.text();
    let raw = body;
    try { const j = JSON.parse(body); raw = j.text ?? j.message ?? body; } catch { /* plain text */ }
    if (!raw.trim()) return json({ error: 'empty' }, 400);
    const p = parse(raw);
    if (!p) return json({ ok: true, ignored: true });
    const category = await categorize(p.kind, p.merchant);
    // Unrecognised messages (e.g. promos containing SAR) are kept for review but never counted.
    const { error } = await db.from('payments').insert({ raw_text: raw, source: 'sms', category, excluded: p.kind === 'unknown', ...p });
    if (error) return json({ error: error.message }, 500);
    let s = null;
    try { s = await summarize(); } catch { /* the notice just leaves out the month total */ }
    return json({ ok: true, category, ...p, notice: notice(p, category, s) });
  }
  return json({ error: 'method' }, 405);
});
