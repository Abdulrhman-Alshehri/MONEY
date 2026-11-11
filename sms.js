// Spending SMS for Scriptable (iPhone): sends each bank SMS to the app, and keeps it on this iPhone until the server has it.
// SMS still arrive without mobile data (abroad with data roaming off, or a weak signal), and a plain Shortcut loses those.
// This script saves the SMS first, sends it, deletes it once the server answers, and sends whatever is still waiting the
// next time it runs. Everything stays in Scriptable's own storage on this iPhone, not in iCloud.
//
// Setup: in Scriptable tap +, paste this, name it "Spending SMS", and tap ▶ to paste an SMS key (in the app: Months ›
// Security › New key › The SMS Shortcut). Then make the SMS automation run this script with the message as its parameter,
// and show the script's result as a notification. The README, "iPhone automation" step 5, has the steps.
// Tap ▶ again any time to see what's waiting, send it now, or change the key.

const API = 'https://itkbgyikekieqbxbbdad.supabase.co/functions/v1/sms-ingest';
const fm = FileManager.local(); // on this iPhone only, never iCloud
const DIR = fm.joinPath(fm.documentsDirectory(), 'spending-sms');
const QUEUE = fm.joinPath(DIR, 'queue');
// The key is kept in a file here, not in the Keychain: the automation usually runs while the iPhone is locked, and a
// Keychain item may not be readable then. Only an SMS key is accepted, and it can do nothing but add SMS.
const KEY_FILE = fm.joinPath(DIR, 'key');
const LAST = fm.joinPath(DIR, 'last.json');
const BUDGET = 15000; // no new send starts after 15 seconds, so the Shortcut never hangs; the rest go next time
const YOUNG = 60000; // another run's SMS saved in the last minute is left to that run
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const when = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MON[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// As the server's norm(): no spaces or invisible direction marks, Arabic digits as Latin ones
const clean = (s) => String(s ?? '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/[\s​-‏‪-‮﻿]/g, '');

// The message as text, whatever form Shortcuts passes it in
function smsText(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  if (Array.isArray(p)) return p.map(smsText).filter((t) => t.trim()).join('\n');
  if (typeof p === 'object') return smsText(p.text ?? p.message ?? p.content ?? p.body ?? '');
  return String(p);
}

function ensureDirs() { if (!fm.fileExists(QUEUE)) fm.createDirectory(QUEUE, true); }
const readKey = () => (fm.fileExists(KEY_FILE) ? clean(fm.readString(KEY_FILE)) : '');
const newId = (d) => `sms-${stamp(d)}-${UUID.string().replace(/-/g, '').slice(0, 8).toLowerCase()}`;

// Saved whole or not at all: written under another name, then renamed
function save(text) {
  ensureDirs();
  const now = new Date(), id = newId(now), file = fm.joinPath(QUEUE, id + '.json'), tmp = fm.joinPath(QUEUE, id + '.tmp');
  fm.writeString(tmp, JSON.stringify({ id, text, at: now.toISOString() }));
  fm.move(tmp, file);
  return { id, text, at: now.toISOString(), file };
}

// Waiting SMS, oldest first (names start with the time)
const waiting = () => (fm.fileExists(QUEUE) ? fm.listContents(QUEUE).filter((n) => n.endsWith('.json')).sort().map((n) => fm.joinPath(QUEUE, n)) : []);
const setAside = () => (fm.fileExists(QUEUE) ? fm.listContents(QUEUE).filter((n) => n.endsWith('.bad')).length : 0);

function readItem(file) {
  try {
    const j = JSON.parse(fm.readString(file));
    if (j && typeof j.id === 'string' && typeof j.text === 'string') return j;
  } catch (e) { /* unreadable */ }
  return null;
}

function forget(file) { try { fm.remove(file); } catch (e) { /* another run already removed it */ } }

async function post(body, key) {
  const r = new Request(API);
  r.method = 'POST';
  r.headers = { 'x-api-key': key, 'Content-Type': 'application/json; charset=utf-8' };
  r.body = JSON.stringify(body);
  r.timeoutInterval = 10;
  let text;
  try { text = await r.loadString(); } catch (e) { return { offline: true }; } // no connection, or the answer never came
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.response && r.response.statusCode, j };
}

// What a send means for the waiting file. stop: the next ones would fail the same way
function outcome(res) {
  if (res.offline) return { why: 'no internet', stop: true, offline: true };
  const { status, j } = res, err = (j && j.error) || `HTTP ${status}`;
  if (status === 200 && j && j.ok) return { done: true, notice: j.notice || '' }; // also a duplicate or a login code, which the server ignores
  if (status === 401) return { why: 'the key was refused', stop: true, key: true };
  if (status === 403) return { why: "this key can't send SMS", stop: true, key: true };
  if (status === 429) return { why: 'too many wrong keys from this network', stop: true };
  if (status >= 400 && status < 500) return { why: `the server refused it (${err})` }; // kept, but don't hold up the others
  return { why: `the server had a problem (${err})`, stop: true };
}

// Save the new SMS (if any), then send it and everything waiting. Returns the line for the notification, or ''.
// all: tapped Send now in the app, so send even the newest and say when there's no internet.
async function run(param, { all = false } = {}) {
  const text = smsText(param);
  let current = null, unsaved = false;
  if (text.trim()) {
    try { current = save(text); } catch (e) { current = { id: newId(new Date()), text, at: new Date().toISOString() }; unsaved = true; } // still sent, as before the queue
  }
  const key = readKey(), start = Date.now(), lines = [];
  let notice = '', earlier = 0, problem = null, late = false, gotCurrent = false;
  if (key) {
    const files = waiting().filter((f) => !current || f !== current.file);
    const jobs = (current ? [{ item: current, file: current.file }] : []).concat(files.map((file) => ({ file })));
    for (const job of jobs) {
      if (Date.now() - start > BUDGET) { late = true; break; }
      let item = job.item;
      if (!item) {
        if (!fm.fileExists(job.file)) continue; // another run sent it
        item = readItem(job.file);
        if (!item) { try { fm.move(job.file, job.file.replace(/\.json$/, '.bad')); } catch (e) { /* gone */ } continue; }
        if (!all && Date.now() - Date.parse(item.at) < YOUNG) continue;
      }
      const o = outcome(await post({ text: item.text, id: item.id, at: item.at }, key)); // at: when it arrived, for an SMS without a date
      if (o.done) {
        if (job.file) forget(job.file);
        if (job.item) { notice = o.notice; gotCurrent = true; } else earlier++;
        continue;
      }
      if (!problem || job.item) problem = o;
      if (o.stop) break;
    }
  }
  const left = waiting().length, n = `(${left} waiting)`;
  if (notice) lines.push(notice);
  if (earlier) lines.push(`${notice ? 'Also sent' : 'Sent'} ${plural(earlier, 'SMS that was', 'SMS that were')} waiting.`);
  if (current && unsaved && !gotCurrent) lines.push(`This SMS couldn't be saved or sent${problem ? ` (${problem.why})` : ''}. A statement import will fill it in.`);
  else if (!key) { if (current || left) lines.push(`SMS waiting: no SMS key yet. In Scriptable, tap ▶ on Spending SMS to add one ${n}.`); }
  else if (problem && problem.key) lines.push(`SMS waiting: ${problem.why}. In Scriptable, tap ▶ on Spending SMS and change the key ${n}.`);
  else if (problem && problem.offline) {
    if (current && !gotCurrent) lines.push(`No internet: this SMS is saved on your iPhone and sent once you're online ${n}.`);
    else if (all) lines.push(`No internet: ${left} SMS still waiting.`);
  } else if (problem) lines.push(`SMS waiting: ${problem.why}. ${problem.stop ? "They're sent later" : "It's tried again next time"} ${n}.`);
  else if (late && left) lines.push(`${left} SMS still waiting, sent next time.`);
  try { ensureDirs(); fm.writeString(LAST, JSON.stringify({ at: new Date().toISOString(), why: key ? (problem ? problem.why : null) : 'no SMS key yet', left })); } catch (e) { /* only for the status */ }
  return lines.join('\n');
}

async function info(message) {
  const a = new Alert();
  a.title = 'Spending SMS';
  a.message = message;
  a.addAction('OK');
  await a.presentAlert();
}

// Checks a key with an empty SMS: a key that may add SMS gets "empty", and nothing is saved
async function askKey(note) {
  const a = new Alert();
  a.title = 'SMS key';
  a.message = (note ? note + '\n\n' : '') + 'In the Spending app: Months › Security › New key › The SMS Shortcut. Copy it and paste it here. It stays in Scriptable on this iPhone and can only add SMS.';
  a.addSecureTextField('sms_…', '');
  a.addAction('Save');
  a.addCancelAction('Cancel');
  if ((await a.presentAlert()) === -1) return '';
  const key = clean(a.textFieldValue(0));
  if (!/^sms_[\w-]{20,}$/.test(key)) return askKey("That isn't an SMS key (they start with sms_). The old token and the other keys aren't used here.");
  const res = await post({ text: '' }, key);
  if (res.status === 401 || res.status === 403) return askKey('The server refused that key. It may have been revoked: make a new one.');
  if (res.status === 429) return askKey('Too many wrong keys from this network. Wait 15 minutes, then try again.');
  ensureDirs();
  fm.writeString(KEY_FILE, key);
  await info(res.status === 400 && res.j && res.j.error === 'empty' ? 'Saved. The key works.'
    : res.offline ? "Saved. It couldn't be checked now (no internet); the next SMS will show whether it works."
    : `Saved, but the server answered ${(res.j && res.j.error) || 'HTTP ' + res.status}; the next SMS will show whether it works.`);
  return key;
}

async function inApp() {
  if (!readKey() && !(await askKey())) return;
  for (;;) {
    const files = waiting(), bad = setAside(), first = files.length ? readItem(files[0]) : null;
    let last = null;
    try { last = fm.fileExists(LAST) ? JSON.parse(fm.readString(LAST)) : null; } catch (e) { /* none */ }
    const parts = ['An SMS key is saved on this iPhone.'];
    parts.push(files.length ? `${files.length} SMS waiting${first ? `, the oldest from ${when(first.at)}` : ''}.` : 'No SMS waiting.');
    if (last && last.at) parts.push(`Last run ${when(last.at)}: ${last.why || 'all sent'}.`);
    if (bad) parts.push(`${plural(bad, 'saved SMS', 'saved SMS')} couldn't be read and ${bad === 1 ? 'was' : 'were'} set aside.`);
    const a = new Alert();
    a.title = 'Spending SMS';
    a.message = parts.join('\n');
    const actions = [];
    if (files.length) { a.addAction('Send now'); actions.push('send'); }
    a.addAction('Change key'); actions.push('key');
    a.addCancelAction('Done');
    const i = await a.presentAlert();
    if (i === -1) return;
    if (actions[i] === 'send') await info((await run(null, { all: true })) || (waiting().length ? 'Nothing could be sent.' : 'All sent.'));
    else await askKey();
  }
}

const param = typeof args !== 'undefined' ? args.shortcutParameter : null;
try {
  if (config.runsInApp && !config.runsWithSiri && param == null) await inApp();
  else {
    const out = await run(param);
    if (out) Script.setShortcutOutput(out);
  }
} catch (e) {
  const msg = `Spending SMS stopped: ${e && e.message ? e.message : e}`;
  if (config.runsInApp && !config.runsWithSiri) await info(msg);
  else Script.setShortcutOutput(msg);
}
Script.complete();
