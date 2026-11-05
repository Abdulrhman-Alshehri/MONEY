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
  if (/حوالة|تحويل/.test(text)) {
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const key = norm(Deno.env.get('APP_TOKEN') ?? '');
  if (!key || norm(req.headers.get('x-api-key') ?? '') !== key) return json({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const id = url.searchParams.get('id');

  if (req.method === 'GET') {
    // Insert order, so a payment that arrives during the read lands on the last page instead of shifting the others
    const { data, error } = await readAll(() => db.from('payments').select('id,amount,currency,merchant,type,kind,category,city,mcc,balance,source,seq,note,excluded,occurred_at,created_at').order('created_at').order('id'));
    return error ? json({ error: error.message }, 500) : json(data);
  }

  if (req.method === 'PATCH' && id) {
    const b = await req.json();
    const patch: Record<string, unknown> = {};
    for (const k of ['category', 'note', 'excluded']) if (k in b) patch[k] = b[k];
    const { data: row, error: e1 } = await db.from('payments').select('merchant').eq('id', id).single();
    if (e1) return json({ error: e1.message }, 404);
    if (b.apply_to_merchant && b.category && row.merchant) {
      await db.from('merchant_rules').upsert({ merchant_key: merchantKey(row.merchant), category: b.category, updated_at: new Date().toISOString() });
      const { error, count } = await db.from('payments').update({ category: b.category }, { count: 'exact' }).eq('merchant', row.merchant);
      if (error) return json({ error: error.message }, 500);
      if ('note' in b || 'excluded' in b) { const { category: _c, ...rest } = patch; await db.from('payments').update(rest).eq('id', id); }
      return json({ ok: true, updated: count });
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
    if (fresh.length) { const { error } = await db.from('payments').insert(fresh); if (error) return json({ error: error.message }, 500); }
    return json({ ok: true, received: rows.length, inserted: fresh.length });
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
    return error ? json({ error: error.message }, 500) : json({ ok: true, category, ...p });
  }
  return json({ error: 'method' }, 405);
});
