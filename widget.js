// Spending widget for Scriptable (iPhone).
// Home Screen: what you've spent this month, what's left after saving, and the comparison with last month.
// Lock Screen: a ring with the share of this month's money already used, as a percentage. No amounts.
// Your token, salary and monthly saving stay in this iPhone's Keychain; nothing personal is written in this file.
//
// Setup: in Scriptable tap +, paste this, name it "Spending", and tap ▶ once to enter your token, salary and saving.
// Then add a Scriptable widget to the Home Screen or the Lock Screen, edit it, and choose "Spending".
// Run it again in Scriptable whenever the token or your plan changes.

const API = 'https://itkbgyikekieqbxbbdad.supabase.co/functions/v1/sms-ingest';
const APP = 'https://candid-gecko-1d5b6a.netlify.app/';
const KEY = { token: 'spending.token', income: 'spending.income', save: 'spending.save' };
const CACHE = 'spending-widget.json';
const BLUE = '#3987e5';
const C = {
  bg: Color.dynamic(new Color('#f9f9f7'), new Color('#0d0d0d')),
  fg: Color.dynamic(new Color('#0b0b0b'), new Color('#f0efec')),
  fg2: Color.dynamic(new Color('#52514e'), new Color('#c3c2b7')),
  good: Color.dynamic(new Color('#006300'), new Color('#0ca30c')),
  bad: Color.dynamic(new Color('#d03b3b'), new Color('#e66767')),
};

const kc = (k) => (Keychain.contains(k) ? Keychain.get(k) : '');
const numberOf = (v) => parseFloat(String(v).replace(/[,\s]/g, '')) || 0;
const whole = (n) => Math.round(n).toLocaleString('en-US');
const clock = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

async function settings() {
  const a = new Alert();
  a.title = 'Spending widget';
  a.message = "Your token, salary and monthly saving are kept only in this iPhone's Keychain.";
  a.addSecureTextField('Token', kc(KEY.token));
  a.addTextField('Monthly salary', kc(KEY.income)).setDecimalPadKeyboard();
  a.addTextField('Save each month', kc(KEY.save)).setDecimalPadKeyboard();
  a.addAction('Save');
  a.addCancelAction('Cancel');
  if ((await a.present()) === -1) return;
  const token = a.textFieldValue(0).trim();
  if (token) Keychain.set(KEY.token, token);
  Keychain.set(KEY.income, String(numberOf(a.textFieldValue(1))));
  Keychain.set(KEY.save, String(numberOf(a.textFieldValue(2))));
}

// This month's summary from the app's server. The last good one is kept, so the widget still shows something offline.
async function load() {
  const fm = FileManager.local(), path = fm.joinPath(fm.documentsDirectory(), CACHE);
  try {
    const r = new Request(API + '?action=summary');
    r.headers = { 'x-api-key': kc(KEY.token) };
    r.timeoutInterval = 20;
    const j = await r.loadJSON();
    if (r.response.statusCode === 401) return { error: 'Token not accepted. Run this script in Scriptable to enter it again.' };
    if (r.response.statusCode !== 200) throw new Error(j.error || 'HTTP ' + r.response.statusCode);
    j.at = Date.now();
    fm.writeString(path, JSON.stringify(j));
    return j;
  } catch (e) {
    if (fm.fileExists(path)) return Object.assign(JSON.parse(fm.readString(path)), { offline: true });
    return { error: 'Could not reach the server.' };
  }
}

// The same plan maths as the app: left = salary − saving − spending − money sent to people.
function plan(s) {
  const income = numberOf(kc(KEY.income)), save = numberOf(kc(KEY.save)), allowance = income > save ? income - save : 0;
  const used = s.spent + s.sent, daysLeft = s.days_in_month - s.day + 1;
  const pct = allowance > 0 ? used / allowance : s.last_total > 0 ? s.spent / s.last_total : 0;
  return { allowance, left: allowance - used, daysLeft, pct };
}

// A ring drawn from short lines (Scriptable has no arcs), with round ends and the percentage in the middle.
function ring(pct, size, line, color, track, textColor) {
  const dc = new DrawContext();
  dc.size = new Size(size, size);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const c = size / 2, r = c - line / 2 - 1;
  const at = (t) => new Point(c + r * Math.cos(-Math.PI / 2 + 2 * Math.PI * t), c + r * Math.sin(-Math.PI / 2 + 2 * Math.PI * t));
  const arc = (to, col) => {
    const p = new Path(), steps = Math.max(2, Math.ceil(to * 90));
    for (let i = 0; i <= steps; i++) i ? p.addLine(at((to * i) / steps)) : p.move(at(0));
    dc.addPath(p);
    dc.setStrokeColor(col);
    dc.setLineWidth(line);
    dc.strokePath();
  };
  arc(1, track);
  const f = Math.min(Math.max(pct, 0), 1);
  if (f > 0) {
    arc(f, color);
    dc.setFillColor(color);
    for (const t of [0, f]) { const q = at(t); dc.fillEllipse(new Rect(q.x - line / 2, q.y - line / 2, line, line)); }
  }
  const label = Math.round(pct * 100) + '%', fs = size * (label.length > 3 ? 0.23 : 0.28);
  dc.setFont(Font.boldSystemFont(fs));
  dc.setTextColor(textColor);
  dc.setTextAlignedCenter();
  dc.drawTextInRect(label, new Rect(0, c - fs * 0.62, size, fs * 1.3));
  return dc.getImage();
}

function text(stack, value, font, color) {
  const t = stack.addText(value);
  t.font = font;
  if (color) t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

function build(family, s) {
  const w = new ListWidget(), lock = family.startsWith('accessory');
  w.url = APP;
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  if (!lock) { w.backgroundColor = C.bg; w.setPadding(14, 14, 14, 14); }
  if (s.error) {
    if (lock) text(w, '!', Font.boldSystemFont(22));
    else { const t = w.addText(s.error); t.font = Font.systemFont(13); t.textColor = C.fg2; }
    return w;
  }
  const n = plan(s);
  // Lock Screen: the ring only, no amounts, because anyone holding the phone can see it
  if (family === 'accessoryCircular') { w.addImage(ring(n.pct, 72, 7, Color.white(), new Color('#ffffff', 0.25), Color.white())).imageSize = new Size(58, 58); return w; }
  if (family === 'accessoryRectangular') {
    const st = w.addStack(); st.centerAlignContent();
    st.addImage(ring(n.pct, 72, 7, Color.white(), new Color('#ffffff', 0.25), Color.white())).imageSize = new Size(46, 46);
    st.addSpacer(8);
    const t = st.addText("of this month's money used"); t.font = Font.systemFont(13); t.lineLimit = 2;
    return w;
  }
  if (family === 'accessoryInline') { w.addText(`${Math.round(n.pct * 100)}% of this month used`); return w; }
  // Home Screen
  const row = w.addStack(); row.layoutHorizontally();
  const col = row.addStack(); col.layoutVertically();
  text(col, 'Spent', Font.systemFont(13), C.fg2);
  text(col, whole(s.spent), Font.boldSystemFont(family === 'small' ? 32 : 36), C.fg);
  col.addSpacer(4);
  if (n.allowance > 0) {
    text(col, n.left >= 0 ? `${whole(n.left)} left` : `${whole(-n.left)} over plan`, Font.semiboldSystemFont(15), n.left >= 0 ? C.fg : C.bad);
    if (n.left >= 0) text(col, `${whole(n.left / n.daysLeft)} a day · ${n.daysLeft} day${n.daysLeft === 1 ? '' : 's'}`, Font.systemFont(13), C.fg2);
  }
  if (s.comparable) {
    const diff = s.spent - s.last_same_day, same = Math.abs(diff) < Math.max(100, s.last_same_day * 0.05), mon = s.last_month.slice(0, 3);
    text(col, same ? `≈ same as ${mon}` : `${diff > 0 ? '▲' : '▼'} ${whole(Math.abs(diff))} vs ${mon}`, Font.systemFont(13), same ? C.fg2 : diff > 0 ? C.bad : C.good);
  } else if (s.stale_days >= 3) text(col, `No SMS for ${s.stale_days} days`, Font.systemFont(13), C.bad);
  col.addSpacer();
  text(col, s.offline ? `Offline · ${clock(s.at)}` : `Updated ${clock(s.at || Date.now())}`, Font.systemFont(11), C.fg2);
  if (family !== 'small') {
    row.addSpacer();
    row.addImage(ring(n.pct, 220, 20, new Color(BLUE), new Color(BLUE, 0.22), new Color(BLUE))).imageSize = new Size(104, 104);
  }
  return w;
}

if (config.runsInApp && !config.runsInWidget) await settings();
const summary = kc(KEY.token) ? await load() : { error: 'Open Scriptable and run this script once to enter your token.' };
const widget = build(config.widgetFamily || 'medium', summary);
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
