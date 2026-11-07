import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-api-key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const norm = (s: string) => s
  .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
  .replace(/[\s​-‏‪-‮﻿]/g, '');

const merchantKey = (m: string | null) => (m ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const KEYWORDS: [RegExp, string][] = [
  [/^ATM cash withdrawal$/, 'Cash withdrawal'],
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
  let type = 'other', kind = 'unknown', merchant: string | null = null, city: string | null = null;
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
  } else if (/سحب\s*نقدي/.test(text)) {
    // Cash taken from an ATM. It counts as spending, since the cash gets spent; the ATM's location is kept as the city.
    type = 'atm'; kind = 'purchase'; merchant = 'ATM cash withdrawal';
    city = text.match(/موقع\s*(.+?)\s*في/)?.[1]?.trim() ?? null;
  } else if (/[إا]يداع/.test(text)) { // SNB writes it with and without the hamza
    type = 'atm'; kind = 'cash_in'; merchant = 'Cash deposit';
  } else if (/[إا]عادة|استرداد|عكس|مرتجع/.test(text)) {
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
  return { amount, type, kind, merchant, occurred_at, city };
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

// A name the user gave a merchant with Rename, applied to new SMS before their category is chosen.
async function aliasOf(merchant: string | null) {
  if (!merchant) return merchant;
  const { data } = await db.from('merchant_aliases').select('name').eq('merchant_key', merchantKey(merchant)).maybeSingle();
  return data?.name ?? merchant;
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
const side = (kind: string) => (['purchase', 'fee', 'transfer_out'].includes(kind) ? 'out' : ['refund', ...INCOMING].includes(kind) ? 'in' : null);

// Statement rows that SMS already saved: the same amount and direction, within 3 minutes of an SMS row that no statement
// row has claimed yet. The SMS row keeps its merchant, category, note and text, and takes the statement's ref, seq,
// balance, city and MCC, so the payment counts once and the balance line runs through it. Unrecognised SMS never match.
// deno-lint-ignore no-explicit-any
async function matchSms(rows: any[]) {
  // deno-lint-ignore no-explicit-any
  const out = new Map<any, string>();
  const times = rows.map((r) => Date.parse(r.occurred_at)).filter(Number.isFinite);
  if (!times.length) return out;
  const from = new Date(Math.min(...times) - DAY).toISOString(), to = new Date(Math.max(...times) + DAY).toISOString();
  const { data, error } = await readAll(() => db.from('payments').select('id,amount,kind,occurred_at').eq('source', 'sms').is('ref', null)
    .gte('occurred_at', from).lte('occurred_at', to).order('created_at').order('id'));
  if (error) throw new Error(error.message);
  const free = data.filter((s) => s.amount != null && s.occurred_at && side(s.kind));
  for (const r of rows) {
    const t = Date.parse(r.occurred_at);
    let best = null, gap = 3 * 60e3 + 1;
    for (const s of free) {
      const d = Math.abs(Date.parse(s.occurred_at) - t);
      if (d < gap && side(s.kind) === side(r.kind) && Math.abs(num(s.amount) - num(r.amount)) < 0.005) { best = s; gap = d; }
    }
    if (best) { out.set(r, best.id); free.splice(free.indexOf(best), 1); }
  }
  return out;
}
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
  const { data: lim } = await db.from('category_limits').select('category,monthly');
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
    categories: Object.fromEntries([...byCat].map(([c, v]) => [c, round2(v)])), // every category this month, for the SMS notice
    limits: Object.fromEntries((lim ?? []).map((l) => [l.category, num(l.monthly)])), // monthly limits the user set
    text,
  };
}

// One line for the Shortcut's notification after each SMS: the payment, then its category's total this month and all
// spending this month, labelled so one total can't be read as the other.
// deno-lint-ignore no-explicit-any
function notice(p: any, category: string, s: any) {
  const a = p.amount == null ? '?' : exact(num(p.amount)), who = p.merchant ?? 'someone';
  const lim = s?.limits?.[category];
  const cat = s ? `${category}: ${whole(s.categories[category] ?? 0)}${lim ? ` of ${whole(lim)}` : ''} this month · ${whole(s.spent)} total` : category;
  switch (p.kind) {
    case 'purchase': case 'fee': return `${p.merchant ?? 'Payment'} ${a} · ${cat}`;
    case 'refund': return `Refund ${a} from ${p.merchant ?? 'a shop'} · ${cat}`;
    case 'income': return `Salary in: ${a}`;
    case 'cash_in': return `Cash deposit: ${a}`;
    case 'transfer_in': return `Received ${a} from ${who}`;
    case 'transfer_out': return category === 'Savings' ? `Moved ${a} to savings` : category === 'Transfers' ? `Sent ${a} to ${who} · not counted as spending` : `${who} ${a} · ${cat}`;
    default: return 'Saved, but not recognised. Check Review in the app.';
  }
}

// ---------- keys ----------
const sha256hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
// What a request may do: everything with APP_TOKEN, or the scope of a key in api_keys (kept as a SHA-256 hash only).
async function scopeOf(req: Request) {
  const given = norm(req.headers.get('x-api-key') ?? ''), app = norm(Deno.env.get('APP_TOKEN') ?? '');
  if (!given) return null;
  if (app && given === app) return 'full';
  const { data } = await db.from('api_keys').select('id,scope').eq('hash', await sha256hex(given)).is('revoked_at', null).maybeSingle();
  if (!data) return null;
  await db.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);
  return data.scope as string;
}

// ---------- push notifications: RFC 8291 encryption and RFC 8292 VAPID, with WebCrypto only ----------
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF with one block of output, which is all RFC 8291 needs (up to 32 bytes)
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) => (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, len);
// Encrypts one message for one device (aes128gcm). Tests pass `as` and `salt`; otherwise both are new for each message.
async function encrypt(plain: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array, as?: CryptoKeyPair, salt?: Uint8Array) {
  as ??= await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  salt ??= crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(plain, new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPublic.length;
  return cat(header, asPublic, body);
}
// A VAPID JWT for the push service's origin, signed by the app server's key (raw r||s, as JWS wants)
async function vapidAuth(endpoint: string, priv: CryptoKey, pubRaw: Uint8Array, subject: string) {
  const j = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));
  const unsigned = `${j({ typ: 'JWT', alg: 'ES256' })}.${j({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${b64u(pubRaw)}`;
}
const SITE = 'https://candid-gecko-1d5b6a.netlify.app'; // the VAPID contact: the site, never a personal address
// The app server's VAPID key pair, made on first use and kept in app_settings. The private key never leaves the database.
let vapidCache: { priv: CryptoKey; pub: Uint8Array } | null = null;
async function vapid() {
  if (vapidCache) return vapidCache;
  const { data } = await db.from('app_settings').select('value').eq('key', 'vapid').maybeSingle();
  let v = data?.value;
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    v = { jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))) };
    const { error } = await db.from('app_settings').insert({ key: 'vapid', value: v });
    if (error) v = (await db.from('app_settings').select('value').eq('key', 'vapid').single()).data?.value; // another request made it first
  }
  vapidCache = { priv: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']), pub: unb64u(v.pub) };
  return vapidCache;
}
// Push services a subscription may point at (Apple, Google, Mozilla, Microsoft), so the server never posts anywhere else
const PUSH_HOSTS = /^https:\/\/([\w-]+\.)*(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)\//;
type Msg = { title: string; body: string; tag?: string };
// One notification to every subscribed device. A device the push service no longer knows (404 or 410) is dropped.
async function push(msg: Msg) {
  const { data: subs, error } = await db.from('push_subscriptions').select('endpoint,p256dh,auth');
  if (error) throw new Error(error.message);
  const errors: string[] = [];
  let sent = 0;
  if (!subs?.length) return { sent, errors };
  const v = await vapid(), plain = enc.encode(JSON.stringify(msg));
  for (const s of subs) {
    try {
      const body = await encrypt(plain, unb64u(s.p256dh), unb64u(s.auth));
      const r = await fetch(s.endpoint, { method: 'POST', body, headers: { authorization: await vapidAuth(s.endpoint, v.priv, v.pub, SITE), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' } });
      if (r.ok) {
        await r.body?.cancel(); sent++;
        await db.from('push_subscriptions').update({ last_ok_at: new Date().toISOString() }).eq('endpoint', s.endpoint);
      } else {
        errors.push(`${new URL(s.endpoint).host} ${r.status} ${(await r.text()).slice(0, 120)}`);
        if (r.status === 404 || r.status === 410) await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      }
    } catch (e) { errors.push((e as Error).message); } // one device failing doesn't stop the others
  }
  return { sent, errors };
}

// ---------- scheduled jobs: pg_cron calls ?action=tick at 7 minutes past every hour ----------
// One run of the scheduler. A forced run (for testing) sends nothing and records nothing: it returns the messages instead.
type Run = { out: Msg[]; alert: (key: string, msg: Msg) => Promise<number> };
function newRun(dry: boolean): Run {
  const out: Msg[] = [];
  return {
    out,
    async alert(key, msg) {
      if (dry) { out.push(msg); return 0; }
      // Each alert goes out once: its key is claimed first, and given back if no device got it, so a later hour tries again
      if ((await db.from('notify_log').insert({ key })).error) return 0;
      let n = 0;
      try { n = (await push(msg)).sent; } finally { if (!n) await db.from('notify_log').delete().eq('key', key); }
      return n;
    },
  };
}
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinal = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const dayOf = (p: { occurred_at: string | null; created_at: string }) => Math.floor((Date.parse(p.occurred_at ?? p.created_at) + RIYADH) / DAY);
const dayOfDate = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY);
const monthOf = (n: number) => isoDay(n).slice(0, 7);
const ROW = 'merchant,amount,kind,category,excluded,occurred_at,created_at';
// Payments from the start of Riyadh day `n` on, in insert order
// deno-lint-ignore no-explicit-any
const readSince = (n: number): Promise<{ data: any[]; error: { message: string } | null }> => {
  const from = new Date(n * DAY - RIYADH).toISOString();
  return readAll(() => db.from('payments').select(ROW).or(`occurred_at.gte."${from}",and(occurred_at.is.null,created_at.gte."${from}")`).order('created_at').order('id'));
};
const fail = (...r: { error: { message: string } | null }[]) => { const e = r.find((x) => x.error)?.error; if (e) throw new Error(e.message); };
// The app's fixedKey(): bills are matched by merchant and exact amount, as fixedCosts() in index.html finds them
const fixedKey = (merchant: string | null, amount: unknown) => `${(merchant ?? '').toLowerCase().trim()}|${num(amount).toFixed(2)}`;
const when = (ahead: number, n: number) => (ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : WEEKDAYS[new Date(n * DAY).getUTCDay()]);
const addMonths = (n: number, k: number) => {
  const d = new Date(n * DAY), y = d.getUTCFullYear(), m = d.getUTCMonth() + k;
  return Math.floor(Date.UTC(y, m, Math.min(d.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate())) / DAY);
};
// Tabby and Tamara plans: an instalment is paid by a payment whose merchant or category contains the provider's name
// (a first instalment paid in a shop shows the shop's name, so its category is what says Tamara), within 1 riyal of the
// instalment, from 3 days before it falls due, earliest first. Each payment counts for one plan only. `paid` is the
// number you entered as paid so far: those instalments count without a payment, and the search starts after them, so
// a payment the app also finds is never counted twice. Same as bnplState() in index.html.
// deno-lint-ignore no-explicit-any
function bnplState(plans: any[], rows: any[]) {
  const used = new Set(), out = new Map<string, { paid: number; next: number | null }>();
  const pays = rows.filter((r) => counts(r) > 0).sort((a, b) => Date.parse(a.occurred_at ?? a.created_at) - Date.parse(b.occurred_at ?? b.created_at) || (a.created_at < b.created_at ? -1 : 1));
  for (const p of [...plans].sort((a, b) => (a.first === b.first ? (String(a.id) < String(b.id) ? -1 : 1) : a.first < b.first ? -1 : 1))) {
    const first = dayOfDate(p.first), key = merchantKey(p.provider), skip = Math.min(p.count, Math.max(0, Math.floor(num(p.paid))));
    const due = (i: number) => (p.every === '2weeks' ? first + 14 * i : addMonths(first, i));
    // deno-lint-ignore no-explicit-any
    const fits = (r: any) => !!key && !used.has(r) && (merchantKey(r.merchant).includes(key) || merchantKey(r.category).includes(key)) && Math.abs(num(r.amount) - num(p.amount)) <= 1;
    pays.filter((r) => fits(r) && dayOf(r) >= first - 3 && dayOf(r) < due(skip) - 3).slice(0, skip).forEach((r) => used.add(r)); // the ones you entered
    const hits = pays.filter((r) => fits(r) && dayOf(r) >= due(skip) - 3).slice(0, p.count - skip);
    hits.forEach((r) => used.add(r));
    const paid = skip + hits.length;
    out.set(p.id, { paid, next: paid >= p.count ? null : due(paid) });
  }
  return out;
}
// Categories at 80% of their monthly limit, or over it. A category that is mostly fixed costs this month (rent) only
// alerts when over, as mostlyFixed() in index.html. A raised limit can alert again.
async function limitAlerts(run: Run, today: number) {
  const t = new Date(today * DAY), y = t.getUTCFullYear(), m = t.getUTCMonth(), start = Math.floor(Date.UTC(y, m, 1) / DAY);
  const left = new Date(Date.UTC(y, m + 1, 0)).getUTCDate() - t.getUTCDate() + 1, togo = `${left} day${left === 1 ? '' : 's'} to go`;
  const [l, b, r] = await Promise.all([db.from('category_limits').select('category,monthly'), db.from('bills').select('key'), readSince(start)]);
  fail(l, b, r);
  const keys = new Set((b.data ?? []).map((x) => x.key)), all = new Map<string, number>(), fixed = new Map<string, number>();
  for (const p of r.data) {
    const v = counts(p);
    if (!v) continue;
    all.set(p.category, (all.get(p.category) || 0) + v);
    if (keys.has(fixedKey(p.merchant, p.amount))) fixed.set(p.category, (fixed.get(p.category) || 0) + v);
  }
  let n = 0;
  for (const { category: c, monthly } of l.data ?? []) {
    const cap = num(monthly), v = all.get(c) || 0, mostlyFixed = v > 0 && (fixed.get(c) || 0) >= v * 0.9;
    if (v > cap) n += await run.alert(`limit100:${c}:${monthOf(today)}:${cap}`, { title: `${c} is over its limit`, body: `${whole(v)} of ${whole(cap)} this month, over by ${whole(v - cap)}, with ${togo}.`, tag: `limit:${c}` });
    else if (v >= cap * 0.8 && !mostlyFixed) n += await run.alert(`limit80:${c}:${monthOf(today)}:${cap}`, { title: `${c}: ${whole(v)} of ${whole(cap)}`, body: `${Math.floor((v / cap) * 100)}% of this month's limit, with ${togo}.`, tag: `limit:${c}` });
  }
  return n;
}
// Due within 2 days: bills the app found (fixed costs) and Tabby or Tamara instalments. As dueSoon() in index.html, a bill
// paid this month is next due on the same day next month.
async function billAlerts(run: Run, today: number) {
  const [b, pl] = await Promise.all([db.from('bills').select('key,label,amount,day,category'), db.from('bnpl_plans').select('id,provider,amount,count,first,every,paid')]);
  fail(b, pl);
  const bills = b.data ?? [], plans = pl.data ?? [];
  if (!bills.length && !plans.length) return 0;
  const t = new Date(today * DAY), y = t.getUTCFullYear(), m = t.getUTCMonth(), start = Math.floor(Date.UTC(y, m, 1) / DAY);
  const r = await readSince(Math.min(start, ...plans.map((p) => dayOfDate(p.first) - 3)));
  fail(r);
  const paidNow = new Set(r.data.filter((p) => dayOf(p) >= start && counts(p) > 0).map((p) => fixedKey(p.merchant, p.amount)));
  const providers = plans.map((p) => merchantKey(p.provider));
  let n = 0;
  for (const x of bills) {
    if (providers.some((k) => k && (x.key.split('|')[0].includes(k) || merchantKey(x.category).includes(k)))) continue; // the plan reminds about these
    const paid = paidNow.has(x.key), mm = paid ? m + 1 : m, dim = new Date(Date.UTC(y, mm + 1, 0)).getUTCDate();
    const due = Math.floor(Date.UTC(y, mm, Math.min(x.day, dim)) / DAY), ahead = due - today;
    if (ahead < 0 || ahead > 2) continue;
    n += await run.alert(`bill:${x.key}:${monthOf(due)}`, { title: `${x.label} ${exact(num(x.amount))} is due ${when(ahead, due)}`, body: `Paid around the ${ordinal(x.day)} each month.`, tag: `bill:${x.key}` });
  }
  const st = bnplState(plans, r.data);
  for (const p of plans) {
    const s = st.get(p.id), ahead = s?.next == null ? -1 : s.next - today;
    if (!s || s.next == null || ahead < 0 || ahead > 2) continue;
    n += await run.alert(`bnpl:${p.id}:${s.paid}`, { title: `${p.provider} ${exact(num(p.amount))} is due ${when(ahead, s.next)}`, body: `Instalment ${s.paid + 1} of ${p.count}${s.paid + 1 === p.count ? ', the last one' : ''}.`, tag: `bnpl:${p.id}` });
  }
  return n;
}
// Nothing from the bank for 3 days: once for each quiet spell
async function staleAlert(run: Run, today: number) {
  const s = await summarize();
  if (s.stale_days < 3) return 0;
  const last = today - s.stale_days;
  return run.alert(`stale:${isoDay(last)}`, { title: `No payments for ${s.stale_days} days`, body: `The last one was on ${WEEKDAYS[new Date(last * DAY).getUTCDay()]} ${new Date(last * DAY).getUTCDate()} ${MONTHS[new Date(last * DAY).getUTCMonth()]}. If you've paid for things since, check that the SMS Shortcut is still on.`, tag: 'stale' });
}
const topCats = (rows: { category: string }[]) => {
  const m = new Map<string, number>();
  for (const p of rows) { const v = counts(p); if (v) m.set(p.category, (m.get(p.category) || 0) + v); }
  return [...m].filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]);
};
// Thursday evening: the last 7 days. Bills are listed on their own, and day-to-day spending is compared with the usual
// week (the 8 weeks before, leaving out weeks with missing days), so a week with rent in it doesn't look like a splurge.
async function weekly(run: Run, today: number) {
  const from = today - 7 * 9 + 1 - 5; // 5 days early, so a gap running into the oldest week is seen in full
  const [b, r] = await Promise.all([db.from('bills').select('key,label'), readSince(from)]);
  fail(b, r);
  const labels = new Map((b.data ?? []).map((x) => [x.key, x.label]));
  const isBill = (p: { merchant: string | null; amount: unknown }) => labels.has(fixedKey(p.merchant, p.amount));
  const perDay = new Map<number, number>(), seen = new Set<number>();
  for (const p of r.data) { const d = dayOf(p); seen.add(d); if (!isBill(p)) perDay.set(d, (perDay.get(d) || 0) + counts(p)); }
  const days = [from - 1, ...[...seen].sort((a, c) => a - c)], ok = (a: number, c: number) => !gaps(days, a, c, today).length;
  const week = (end: number) => { let s = 0; for (let d = end - 6; d <= end; d++) s += perDay.get(d) || 0; return s; };
  const now = r.data.filter((p) => dayOf(p) > today - 7), billRows = now.filter((p) => isBill(p) && counts(p) > 0);
  const total = now.reduce((s, p) => s + counts(p), 0), billSum = billRows.reduce((s, p) => s + counts(p), 0), v = week(today);
  const parts: string[] = [];
  if (billSum) parts.push(`Bills ${whole(billSum)}: ${[...new Set(billRows.map((p) => labels.get(fixedKey(p.merchant, p.amount))))].join(', ')}.`);
  const past = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => today - 7 * k).filter((e) => ok(e - 6, e)).map(week);
  if (today - days[days.length - 1] >= 3 || !ok(today - 6, today)) parts.push('Some days have no data, so there is no comparison.');
  else if (past.length >= 3) {
    const usual = past.reduce((s, x) => s + x, 0) / past.length, d = v - usual;
    const verdict = Math.abs(d) < Math.max(100, usual * 0.05) ? 'about your usual week' : `${Math.round((Math.abs(d) / usual) * 100)}% ${d > 0 ? 'more' : 'less'} than your usual week`;
    parts.push(billSum ? `Day to day ${whole(v)}, ${verdict}.` : `${verdict[0].toUpperCase()}${verdict.slice(1)} (${whole(usual)}).`);
  }
  const top = topCats(now.filter((p) => !isBill(p))).slice(0, 2);
  if (top.length) parts.push(top.map(([c, x]) => `${c} ${whole(x)}`).join(', ') + '.');
  return run.alert(`weekly:${isoDay(today)}`, { title: `This week: ${whole(total)} SAR`, body: parts.join(' ') || 'Nothing spent this week.', tag: 'weekly' });
}
// The 1st of the month: last month against usual, the biggest changes and new places. Same as recapCard() in index.html.
async function recapPush(run: Run, today: number) {
  const r = await readAll(() => db.from('payments').select(ROW).order('created_at').order('id'));
  fail(r);
  const data = r.data;
  if (!data.length) return 0;
  const seen = [...new Set(data.map(dayOf))].sort((a, b) => a - b);
  const mIdx = (p: { occurred_at: string | null; created_at: string }) => { const d = new Date(dayOf(p) * DAY); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const t = new Date(today * DAY), last = t.getUTCFullYear() * 12 + t.getUTCMonth() - 1, firstM = Math.min(...data.map(mIdx));
  if (last < firstM) return 0;
  // As partial() in index.html: a month starting before the first payment, or touching a gap of 5+ days
  const partial = (x: number) => { const a = Math.floor(Date.UTC(Math.floor(x / 12), x % 12, 1) / DAY), b = Math.min(Math.floor(Date.UTC(Math.floor(x / 12), x % 12 + 1, 0) / DAY), today); return seen[0] > a || gaps(seen, a, b, today).length > 0; };
  const sumOf = (x: number) => data.reduce((s, p) => s + (mIdx(p) === x ? counts(p) : 0), 0);
  const byCat = (x: number) => { const m = new Map<string, number>(); for (const p of data) if (mIdx(p) === x) { const v = counts(p); if (v) m.set(p.category, (m.get(p.category) || 0) + v); } return m; };
  const total = sumOf(last), prev = [1, 2, 3].map((k) => last - k).filter((x) => x >= firstM && !partial(x));
  let body = '';
  if (partial(last)) body = 'Some days have no data, so there is no comparison.';
  else if (prev.length) {
    const usual = prev.reduce((s, x) => s + sumOf(x), 0) / prev.length, d = total - usual;
    body = Math.abs(d) < Math.max(100, usual * 0.05) ? 'About your usual.' : `${whole(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than usual.`;
    const cur = byCat(last), avg = new Map<string, number>();
    for (const x of prev) for (const [c, v] of byCat(x)) avg.set(c, (avg.get(c) || 0) + v / prev.length);
    const ch = [...new Set([...cur.keys(), ...avg.keys()])].map((c) => [c, (cur.get(c) || 0) - (avg.get(c) || 0)] as [string, number]).filter(([c, x]) => Math.abs(x) >= 100 && c !== 'Uncategorized').sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
    if (ch.length) body += ' ' + ch.map(([c, x]) => `${c} ${x > 0 ? '+' : '−'}${whole(Math.abs(x))}`).join(', ') + '.';
  }
  // New places: shops, not people, so a transfer counted as spending never puts a name on the lock screen
  const before = new Set(data.filter((p) => mIdx(p) < last).map((p) => merchantKey(p.merchant)));
  const fresh = [...new Set(data.filter((p) => mIdx(p) === last && counts(p) > 0 && p.kind !== 'transfer_out' && p.merchant && !before.has(merchantKey(p.merchant))).map((p) => p.merchant))];
  if (fresh.length) body += ` New: ${fresh.slice(0, 3).join(', ')}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''}.`;
  return run.alert(`recap:${monthOf(Math.floor(Date.UTC(Math.floor(last / 12), last % 12, 1) / DAY))}`, { title: `${MONTHS[last % 12]}: ${whole(total)} SAR`, body: body.trim() || 'Your first month in the app.', tag: 'recap' });
}
// Thursday night: a gzipped copy of every table you'd need to rebuild, in the private `backups` bucket, keeping the last 12.
// Keys, push devices and the alert log are left out on purpose.
const BACKUP: Record<string, string[]> = { payments: ['created_at', 'id'], merchant_rules: ['merchant_key'], merchant_aliases: ['merchant_key'], category_limits: ['category'], bills: ['key'], bnpl_plans: ['id'] };
async function backup(today: number) {
  const out: Record<string, unknown> = { made_at: new Date().toISOString() };
  for (const [table, order] of Object.entries(BACKUP)) {
    const r = await readAll(() => order.reduce((q, c) => q.order(c), db.from(table).select('*')));
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    out[table] = r.data;
  }
  const file = `${isoDay(today)}.json.gz`;
  const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(out)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const { error } = await db.storage.from('backups').upload(file, gz, { contentType: 'application/gzip', upsert: true });
  if (error) throw new Error(error.message);
  const { data: files } = await db.storage.from('backups').list('', { limit: 200, sortBy: { column: 'name', order: 'desc' } });
  const old = (files ?? []).map((f) => f.name).filter((n) => /^\d{4}-\d\d-\d\d\.json\.gz$/.test(n)).sort().reverse().slice(12);
  if (old.length) await db.storage.from('backups').remove(old);
  const info = { at: new Date().toISOString(), file, payments: (out.payments as unknown[]).length, bytes: gz.length };
  await db.from('app_settings').upsert({ key: 'last_backup', value: info, updated_at: info.at });
  return info;
}
// Runs what's due this hour, in Riyadh time. Each job has a window of a few hours and runs once in it, so one missed
// hour loses nothing. Alerts only run while a device is subscribed. `force` runs one job (or 'all') now, sending nothing.
async function tick(force: string | null) {
  const now = new Date(Date.now() + RIYADH), h = now.getUTCHours(), dow = now.getUTCDay(), today = Math.floor(now.getTime() / DAY);
  const lastMonth = monthOf(Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) / DAY));
  const run = newRun(!!force), done: Record<string, unknown> = {};
  const { count: devices } = await db.from('push_subscriptions').select('endpoint', { count: 'exact', head: true });
  const logged = async (key: string) => !!(await db.from('notify_log').select('key').eq('key', key).maybeSingle()).data;
  const due = async (job: string, window: boolean, key?: string) =>
    force ? force === job || force === 'all' : window && (job === 'backup' || !!devices) && !(key && (await logged(key)));
  const go = async (job: string, f: () => Promise<unknown>) => { try { done[job] = await f(); } catch (e) { done[job] = `error: ${(e as Error).message}`; } };
  if (await due('backup', dow === 4 && h >= 3 && h <= 8, `backup:${isoDay(today)}`)) {
    await go('backup', async () => { const info = await backup(today); if (!force) await db.from('notify_log').insert({ key: `backup:${isoDay(today)}` }); return info; });
  }
  if (await due('limits', h >= 9 && h <= 22)) await go('limits', () => limitAlerts(run, today));
  if (await due('bills', h >= 10 && h <= 21)) await go('bills', () => billAlerts(run, today));
  if (await due('recap', now.getUTCDate() === 1 && h >= 10 && h <= 21, `recap:${lastMonth}`)) await go('recap', () => recapPush(run, today));
  if (await due('weekly', dow === 4 && h >= 20 && h <= 23, `weekly:${isoDay(today)}`)) await go('weekly', () => weekly(run, today));
  if (await due('stale', h >= 21 && h <= 23)) await go('stale', () => staleAlert(run, today));
  return force ? { done, messages: run.out } : { done };
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const scope = await scopeOf(req);
  if (!scope) return json({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const id = url.searchParams.get('id');

  // The scheduler's key can only run the scheduled jobs. With the full key, ?force=<job> runs one now and sends nothing.
  if (req.method === 'POST' && action === 'tick' && (scope === 'cron' || scope === 'full')) {
    return json({ ok: true, ...(await tick(scope === 'full' ? url.searchParams.get('force') : null)) });
  }
  if (scope !== 'full') return json({ error: 'forbidden' }, 403);

  // Push: the public key to subscribe with, devices in and out, a test message, and a status line for the app
  if (req.method === 'GET' && action === 'push-key') return json({ key: b64u((await vapid()).pub) });
  if (req.method === 'POST' && action === 'subscribe') {
    const b = await req.json();
    const ok = typeof b?.endpoint === 'string' && b.endpoint.length < 1000 && PUSH_HOSTS.test(b.endpoint) && /^[\w-]{80,100}$/.test(b?.keys?.p256dh ?? '') && /^[\w-]{16,30}$/.test(b?.keys?.auth ?? '');
    if (!ok) return json({ error: 'expected {endpoint, keys: {p256dh, auth}} from a push service' }, 400);
    const { error } = await db.from('push_subscriptions').upsert({ endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth });
    return error ? json({ error: error.message }, 500) : json({ ok: true });
  }
  if (req.method === 'POST' && action === 'unsubscribe') {
    const b = await req.json();
    const { error } = await db.from('push_subscriptions').delete().eq('endpoint', String(b?.endpoint ?? ''));
    return error ? json({ error: error.message }, 500) : json({ ok: true });
  }
  if (req.method === 'POST' && action === 'push-test') {
    return json({ ok: true, ...(await push({ title: 'Notifications are on', body: 'You\'ll get the weekly summary, the monthly recap, bills and instalments due, limits, and a warning if SMS stop arriving.', tag: 'test' })) });
  }
  if (req.method === 'GET' && action === 'status') {
    const [b, d] = await Promise.all([db.from('app_settings').select('value').eq('key', 'last_backup').maybeSingle(), db.from('push_subscriptions').select('endpoint', { count: 'exact', head: true })]);
    return json({ last_backup: b.data?.value ?? null, devices: d.count ?? 0 });
  }
  // The bills the app found (its fixed costs), sent whole whenever they change, for the reminders
  if (req.method === 'PUT' && action === 'bills') {
    const list = await req.json();
    const okBill = (x: Record<string, unknown>) => typeof x?.key === 'string' && x.key.length <= 160 && /\|\d+\.\d\d$/.test(x.key) && typeof x.label === 'string' && !!x.label && Number(x.amount) > 0 && Number.isInteger(x.day) && Number(x.day) >= 1 && Number(x.day) <= 31;
    if (!Array.isArray(list) || list.length > 200 || !list.every(okBill)) return json({ error: 'expected [{key, label, amount, day, category}]' }, 400);
    const now = new Date().toISOString(), rows = [...new Map(list.map((x) => [x.key, { key: x.key, label: x.label.slice(0, 80), amount: round2(Number(x.amount)), day: x.day, category: typeof x.category === 'string' ? x.category.slice(0, 40) : null, updated_at: now }])).values()];
    if (rows.length) { const { error } = await db.from('bills').upsert(rows); if (error) return json({ error: error.message }, 500); }
    const { data: have, error: e1 } = await db.from('bills').select('key');
    if (e1) return json({ error: e1.message }, 500);
    const gone = (have ?? []).map((x) => x.key).filter((k) => !rows.some((x) => x.key === k));
    if (gone.length) { const { error } = await db.from('bills').delete().in('key', gone); if (error) return json({ error: error.message }, 500); }
    return json({ ok: true, bills: rows.length });
  }
  // Tabby and Tamara plans you entered. PUT sends the whole set, as for limits; the app makes each plan's id.
  if (action === 'bnpl' && req.method === 'GET') {
    const { data, error } = await db.from('bnpl_plans').select('id,provider,amount,count,first,every,paid,note').order('first').order('id');
    return error ? json({ error: error.message }, 500) : json(data);
  }
  if (action === 'bnpl' && req.method === 'PUT') {
    const list = await req.json();
    const okPlan = (p: Record<string, unknown>) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(p?.id)) && typeof p.provider === 'string' && !!p.provider.trim() &&
      Number(p.amount) > 0 && Number.isInteger(p.count) && Number(p.count) >= 1 && Number(p.count) <= 36 && /^\d{4}-\d\d-\d\d$/.test(String(p.first)) && !isNaN(Date.parse(String(p.first))) && ['month', '2weeks'].includes(String(p.every ?? 'month')) &&
      (p.paid == null || (Number.isInteger(p.paid) && Number(p.paid) >= 0 && Number(p.paid) <= Number(p.count)));
    if (!Array.isArray(list) || list.length > 50 || !list.every(okPlan)) return json({ error: 'expected [{id, provider, amount, count, first, every, paid}]' }, 400);
    const rows = list.map((p) => ({ id: p.id.toLowerCase(), provider: p.provider.trim().slice(0, 40), amount: round2(Number(p.amount)), count: p.count, first: p.first, every: p.every ?? 'month', paid: p.paid ?? 0, note: typeof p.note === 'string' && p.note.trim() ? p.note.trim().slice(0, 80) : null }));
    if (rows.length) { const { error } = await db.from('bnpl_plans').upsert(rows); if (error) return json({ error: error.message }, 500); }
    const { data: have, error: e1 } = await db.from('bnpl_plans').select('id');
    if (e1) return json({ error: e1.message }, 500);
    const gone = (have ?? []).map((x) => x.id).filter((k) => !rows.some((x) => x.id === k));
    if (gone.length) { const { error } = await db.from('bnpl_plans').delete().in('id', gone); if (error) return json({ error: error.message }, 500); }
    return json({ ok: true, plans: rows.length });
  }

  if (req.method === 'GET' && action === 'summary') {
    try { return json(await summarize()); } catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  // Monthly limits per category. PUT sends the whole set: a category left out loses its limit.
  if (action === 'limits' && req.method === 'GET') {
    const { data, error } = await db.from('category_limits').select('category,monthly').order('category');
    return error ? json({ error: error.message }, 500) : json(data);
  }
  if (action === 'limits' && req.method === 'PUT') {
    const list = await req.json();
    if (!Array.isArray(list) || list.some((l) => typeof l?.category !== 'string' || !l.category || !(Number(l.monthly) > 0))) return json({ error: 'expected [{category, monthly}]' }, 400);
    const now = new Date().toISOString();
    if (list.length) {
      const { error } = await db.from('category_limits').upsert(list.map((l) => ({ category: l.category, monthly: round2(Number(l.monthly)), updated_at: now })));
      if (error) return json({ error: error.message }, 500);
    }
    const { data: have, error: e1 } = await db.from('category_limits').select('category');
    if (e1) return json({ error: e1.message }, 500);
    const gone = (have ?? []).map((l) => l.category).filter((c) => !list.some((l) => l.category === c));
    if (gone.length) { const { error } = await db.from('category_limits').delete().in('category', gone); if (error) return json({ error: error.message }, 500); }
    return json({ ok: true, limits: list.length });
  }

  // Rename a merchant: this payment only, or with `all` every payment with the same name (capitals and spacing don't
  // matter) plus new SMS and statement rows. A category rule for the old name carries over to the new one.
  if (req.method === 'POST' && action === 'rename') {
    const b = await req.json();
    const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
    if (!b.id || !name) return json({ error: 'id and name required' }, 400);
    const { data: row, error: e1 } = await db.from('payments').select('merchant').eq('id', b.id).single();
    if (e1) return json({ error: e1.message }, 404);
    if (!b.all || !row.merchant) {
      const { error } = await db.from('payments').update({ merchant: name }).eq('id', b.id);
      return error ? json({ error: error.message }, 500) : json({ ok: true, updated: 1 });
    }
    const key = merchantKey(row.merchant), now = new Date().toISOString();
    const { data: all, error: e2 } = await readAll(() => db.from('payments').select('id,merchant').not('merchant', 'is', null).order('created_at').order('id'));
    if (e2) return json({ error: e2.message }, 500);
    const ids = all.filter((p) => merchantKey(p.merchant) === key).map((p) => p.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await db.from('payments').update({ merchant: name }).in('id', ids.slice(i, i + 200));
      if (error) return json({ error: error.message }, 500);
    }
    // New rows with the old name, and names that were earlier renamed to it, become the new name
    const { data: aliases, error: e3 } = await db.from('merchant_aliases').select('merchant_key,name');
    if (e3) return json({ error: e3.message }, 500);
    const repoint = (aliases ?? []).filter((a) => merchantKey(a.name) === key && a.merchant_key !== key).map((a) => ({ merchant_key: a.merchant_key, name, updated_at: now }));
    const { error: e4 } = await db.from('merchant_aliases').upsert([{ merchant_key: key, name, updated_at: now }, ...repoint]);
    if (e4) return json({ error: e4.message }, 500);
    const { data: rule } = await db.from('merchant_rules').select('category').eq('merchant_key', key).maybeSingle();
    if (rule && merchantKey(name) !== key) {
      const { data: has } = await db.from('merchant_rules').select('category').eq('merchant_key', merchantKey(name)).maybeSingle();
      if (!has) await db.from('merchant_rules').insert({ merchant_key: merchantKey(name), category: rule.category, updated_at: now });
    }
    return json({ ok: true, updated: ids.length });
  }

  // Rename, merge or delete a category everywhere: payments, rules and limits. Deleting moves it to Uncategorized.
  if (req.method === 'POST' && action === 'category') {
    const b = await req.json();
    const from = typeof b.from === 'string' ? b.from : '', to = typeof b.to === 'string' ? b.to.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
    if (!from || !to || from === to) return json({ error: 'from and to required' }, 400);
    const { data: moved, error } = await db.from('payments').update({ category: to }).eq('category', from).select('id');
    if (error) return json({ error: error.message }, 500);
    const { error: e1 } = await db.from('merchant_rules').update({ category: to, updated_at: new Date().toISOString() }).eq('category', from);
    if (e1) return json({ error: e1.message }, 500);
    const { data: lim, error: e2 } = await db.from('category_limits').select('category,monthly').in('category', [from, to]);
    if (e2) return json({ error: e2.message }, 500);
    const old = (lim ?? []).find((l) => l.category === from);
    if (old) {
      // A merge keeps the limit already on the target; Uncategorized never gets one
      if (to !== 'Uncategorized' && !(lim ?? []).some((l) => l.category === to)) await db.from('category_limits').insert({ category: to, monthly: old.monthly });
      await db.from('category_limits').delete().eq('category', from);
    }
    return json({ ok: true, updated: moved?.length ?? 0 });
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
    // Rows SMS already saved go onto those SMS rows instead of being added again
    // deno-lint-ignore no-explicit-any
    let matched: Map<any, string>;
    try { matched = await matchSms(fresh); } catch (err) { return json({ error: (err as Error).message }, 500); }
    for (const [r, smsRow] of matched) {
      const patch: Record<string, unknown> = { ref: r.ref, seq: r.seq ?? null, balance: r.balance ?? null };
      if (r.city) patch.city = r.city;
      if (r.mcc) patch.mcc = r.mcc;
      const { error } = await db.from('payments').update(patch).eq('id', smsRow);
      if (error) return json({ error: error.message }, 500);
    }
    // deno-lint-ignore no-explicit-any
    const add = fresh.filter((r: any) => !matched.has(r));
    // Your renames and rules win over the statement's guess, as they do for SMS. Money received keeps its own category.
    const { data: aliases, error: e2 } = await db.from('merchant_aliases').select('merchant_key,name');
    if (e2) return json({ error: e2.message }, 500);
    const alias = new Map((aliases ?? []).map((a) => [a.merchant_key, a.name]));
    const { data: rules, error: e3 } = await readAll(() => db.from('merchant_rules').select('merchant_key,category').order('merchant_key'));
    if (e3) return json({ error: e3.message }, 500);
    const rule = new Map(rules.map((r) => [r.merchant_key, r.category]));
    let ruled = 0;
    for (const r of add) {
      if (r.merchant && alias.has(merchantKey(r.merchant))) r.merchant = alias.get(merchantKey(r.merchant));
      const c = r.merchant ? rule.get(merchantKey(r.merchant)) : undefined;
      if (c && !INCOMING.includes(r.kind) && r.category !== c) { r.category = c; ruled++; }
    }
    if (add.length) { const { error } = await db.from('payments').insert(add); if (error) return json({ error: error.message }, 500); }
    return json({ ok: true, received: rows.length, inserted: add.length, matched_sms: matched.size, categorized_by_rules: ruled });
  }

  if (req.method === 'POST') {
    const body = await req.text();
    let raw = body, smsId: string | null = null;
    try {
      const j = JSON.parse(body);
      raw = String(j.text ?? j.message ?? body);
      // An id from a Shortcut that queues SMS while offline: the same id sent again is ignored, so retries are safe
      if (typeof j.id === 'string' && /^[\w.:-]{1,100}$/.test(j.id)) smsId = j.id;
    } catch { /* plain text */ }
    if (!raw.trim()) return json({ error: 'empty' }, 400);
    const p = parse(raw);
    if (!p) return json({ ok: true, ignored: true });
    p.merchant = await aliasOf(p.merchant);
    const category = await categorize(p.kind, p.merchant);
    // Unrecognised messages (e.g. promos containing SAR) are kept for review but never counted.
    const { error } = await db.from('payments').insert({ raw_text: raw, source: 'sms', category, excluded: p.kind === 'unknown', sms_id: smsId, ...p });
    if (error && error.code === '23505' && smsId) return json({ ok: true, duplicate: true });
    if (error) return json({ error: error.message }, 500);
    let s = null;
    try { s = await summarize(); } catch { /* the notice just leaves out the month total */ }
    return json({ ok: true, category, ...p, notice: notice(p, category, s) });
  }
  return json({ error: 'method' }, 405);
}

Deno.serve(async (req) => {
  try { return await handle(req); } catch (e) {
    return e instanceof SyntaxError ? json({ error: 'invalid JSON' }, 400) : json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});
