import express from 'express';
import path from 'node:path';
import { ROOT, q, json, dayKey, addDays, getSettings, setSetting, getProfile, setProfile, getCheckin, getPlan, savePlan, itemRow } from './db.js';
import * as ai from './ai.js';
import { publicKey, saveSubscription, subscriptionCount, sendPush } from './push.js';
import { sseHandler, broadcast } from './bus.js';
import { startScheduler } from './scheduler.js';
import { ACCESS_KEY, loginHandler, logoutHandler, requireAuth } from './auth.js';

const PORT = Number(process.env.PORT) || 3737;
const HOST = process.env.HOST || '127.0.0.1'; // only reachable via localhost / Tailscale serve

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// public endpoints – everything else under /api needs the access key
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.post('/api/login', loginHandler);
app.post('/api/logout', logoutHandler);
app.use('/api', requireAuth);

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

app.get('/api/events', sseHandler);

// ======================= TODAY =======================
app.get('/api/today', wrap((req, res) => {
  const day = dayKey();
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  res.json({
    day,
    name: getSettings().name,
    morning: getCheckin(day, 'morning'),
    evening: getCheckin(day, 'evening'),
    plan: getPlan(day),
    due: q.all(`SELECT * FROM items WHERE status='open' AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at`, endOfDay.getTime()).map(itemRow),
    chocWeek: chocWeek(),
    pushSubs: subscriptionCount(),
  });
}));

async function generatePlan(day, checkin) {
  savePlan(day, { status: 'generating' });
  broadcast('today');
  try {
    const p = await ai.morningPlan(checkin);
    savePlan(day, { status: 'ready', greeting: p.greeting, tip: p.tip, moments: p.moments.map((m) => ({ ...m, done: false })) });
  } catch (e) {
    console.error('[plan]', e.message);
    savePlan(day, { status: 'error', error: e.message });
  }
  broadcast('today');
}

app.post('/api/checkin/morning', wrap((req, res) => {
  const day = dayKey();
  const data = { sleep: req.body.sleep ?? null, energy: req.body.energy ?? null, note: (req.body.note || '').trim() };
  q.run(`INSERT INTO checkins(day, type, data, created_at) VALUES(?, 'morning', ?, ?)
         ON CONFLICT(day, type) DO UPDATE SET data = excluded.data`, day, JSON.stringify(data), Date.now());
  generatePlan(day, data);
  res.json({ ok: true });
}));

app.post('/api/plan/regenerate', wrap((req, res) => {
  const day = dayKey();
  generatePlan(day, getCheckin(day, 'morning')?.data || null);
  res.json({ ok: true });
}));

app.post('/api/plan/toggle', wrap((req, res) => {
  const day = dayKey();
  const plan = getPlan(day);
  const m = plan?.moments?.[req.body.index];
  if (!m) return res.status(404).json({ error: 'not found' });
  m.done = !m.done;
  savePlan(day, plan);
  res.json(plan);
}));

app.post('/api/plan/swap', wrap(async (req, res) => {
  const day = dayKey();
  const i = req.body.index;
  const plan = getPlan(day);
  if (!plan?.moments?.[i]) return res.status(404).json({ error: 'not found' });
  plan.moments[i].swapping = true;
  savePlan(day, plan);
  res.json({ ok: true });
  broadcast('today');
  try {
    const m = await ai.swapMoment(plan, i);
    const fresh = getPlan(day);
    fresh.moments[i] = { ...m, done: false };
    savePlan(day, fresh);
  } catch (e) {
    const fresh = getPlan(day);
    delete fresh.moments[i].swapping;
    savePlan(day, fresh);
  }
  broadcast('today');
}));

app.post('/api/checkin/evening', wrap((req, res) => {
  const day = dayKey();
  const data = { mood: req.body.mood ?? null, choc: req.body.choc ?? null, moved: !!req.body.moved, note: (req.body.note || '').trim() };
  q.run(`INSERT INTO checkins(day, type, data, ai, created_at) VALUES(?, 'evening', ?, NULL, ?)
         ON CONFLICT(day, type) DO UPDATE SET data = excluded.data, ai = NULL`, day, JSON.stringify(data), Date.now());
  res.json({ ok: true });
  ai.eveningReply(data, getPlan(day))
    .then((r) => q.run(`UPDATE checkins SET ai = ? WHERE day = ? AND type = 'evening'`, JSON.stringify(r), day))
    .catch((e) => {
      console.error('[evening]', e.message);
      q.run(`UPDATE checkins SET ai = ? WHERE day = ? AND type = 'evening'`,
        JSON.stringify({ reply: 'Danke für deinen Abschluss! 🌙 Schlaf gut – morgen geht’s weiter.' }), day);
    })
    .finally(() => broadcast('today'));
}));

// ======================= ITEMS / INBOX =======================
app.get('/api/items', wrap((req, res) => {
  res.json({
    open: q.all(`SELECT * FROM items WHERE status='open' ORDER BY due_at IS NULL, due_at, created_at DESC`).map(itemRow),
    done: q.all(`SELECT * FROM items WHERE status='done' ORDER BY done_at DESC LIMIT 15`).map(itemRow),
  });
}));

function localToMs(s) {
  if (!s) return null;
  const t = new Date(s).getTime(); // "YYYY-MM-DDTHH:MM" is parsed as local time
  return Number.isFinite(t) ? t : null;
}

app.post('/api/inbox', wrap((req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'leer' });
  const { id } = q.run(`INSERT INTO items(raw, title, kind, processing, created_at) VALUES(?, ?, 'todo', 1, ?)`, text, text, Date.now());
  res.json({ id });
  broadcast('items');
  ai.parseInbox(text).then((items) => {
    items.forEach((it, idx) => {
      const due = it.kind === 'reminder' ? localToMs(it.due_local) : null;
      const kind = it.kind === 'reminder' && !due ? 'todo' : it.kind;
      if (idx === 0) {
        q.run(`UPDATE items SET title=?, kind=?, area=?, emoji=?, due_at=?, processing=0 WHERE id=?`, it.title, kind, it.area, it.emoji, due, id);
      } else {
        q.run(`INSERT INTO items(raw, title, kind, area, emoji, due_at, processing, created_at) VALUES(?, ?, ?, ?, ?, ?, 0, ?)`,
          text, it.title, kind, it.area, it.emoji, due, Date.now());
      }
    });
  }).catch((e) => {
    console.error('[inbox]', e.message);
    q.run(`UPDATE items SET processing=0, emoji='📝' WHERE id=?`, id);
  }).finally(() => broadcast('items'));
}));

app.patch('/api/items/:id', wrap((req, res) => {
  const item = q.get('SELECT * FROM items WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const title = req.body.title ?? item.title;
  let due = item.due_at, kind = item.kind, notified = item.notified_at, nag = item.nag_count;
  if ('due_at' in req.body) {
    due = req.body.due_at;
    kind = due ? 'reminder' : (item.kind === 'reminder' ? 'todo' : item.kind);
    notified = null; nag = 0;
  }
  q.run('UPDATE items SET title=?, due_at=?, kind=?, notified_at=?, nag_count=? WHERE id=?', title, due, kind, notified, nag, item.id);
  broadcast('items');
  res.json(itemRow(q.get('SELECT * FROM items WHERE id = ?', item.id)));
}));

app.post('/api/items/:id/done', wrap((req, res) => {
  const item = q.get('SELECT status FROM items WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const undo = item.status === 'done' && req.body?.toggle;
  q.run('UPDATE items SET status=?, done_at=? WHERE id=?', undo ? 'open' : 'done', undo ? null : Date.now(), req.params.id);
  broadcast('items');
  res.json({ ok: true });
}));

app.post('/api/items/:id/snooze', wrap((req, res) => {
  const min = Number(req.body?.minutes) || 15;
  q.run(`UPDATE items SET due_at=?, kind='reminder', notified_at=NULL, nag_count=0 WHERE id=?`, Date.now() + min * 60000, req.params.id);
  broadcast('items');
  res.json({ ok: true });
}));

app.delete('/api/items/:id', wrap((req, res) => {
  q.run('DELETE FROM items WHERE id = ?', req.params.id);
  broadcast('items');
  res.json({ ok: true });
}));

// ======================= CHOCOLATE =======================
function dayStatus(day) {
  const e = getCheckin(day, 'evening');
  if (e?.data?.choc) return e.data.choc; // none | little | lots
  const start = new Date(`${day}T00:00`).getTime();
  const ate = q.get(`SELECT COUNT(*) n FROM cravings WHERE outcome='ate' AND created_at >= ? AND created_at < ?`, start, start + 86400000).n;
  return ate ? 'little' : 'unknown';
}

function chocWeek() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    days.push({ day: dayKey(d), wd: d.toLocaleDateString('de-DE', { weekday: 'narrow' }), status: dayStatus(dayKey(d)) });
  }
  // streak of chocolate-free days (today counts only once it's confirmed)
  let streak = 0;
  const today = dayStatus(dayKey());
  if (today === 'little' || today === 'lots') return { days, streak: 0 };
  if (today === 'none') streak++;
  for (let i = 1; i < 365; i++) {
    if (dayStatus(dayKey(addDays(new Date(), -i))) !== 'none') break;
    streak++;
  }
  return { days, streak };
}

app.get('/api/choc', wrap((req, res) => {
  const active = q.get(`SELECT * FROM cravings WHERE outcome='pending' AND created_at > ? ORDER BY id DESC LIMIT 1`, Date.now() - 30 * 60000);
  const weekAgo = addDays(new Date(), -7).getTime();
  const week = q.get(`SELECT COUNT(*) n, SUM(outcome='resisted') r FROM cravings WHERE created_at > ? AND trigger IS NOT 'log'`, weekAgo);
  const hours = Array(24).fill(0);
  for (const c of q.all(`SELECT created_at FROM cravings WHERE created_at > ?`, addDays(new Date(), -30).getTime())) {
    hours[new Date(c.created_at).getHours()]++;
  }
  res.json({
    active: active ? { ...active, ai: json(active.ai) } : null,
    week: { total: week.n, resisted: week.r || 0 },
    hours,
    total30: hours.reduce((a, b) => a + b, 0),
    ...chocWeek(),
    insight: json(getSettings().choc_insight),
  });
}));

app.post('/api/cravings', wrap((req, res) => {
  const { id } = q.run(`INSERT INTO cravings(created_at, outcome) VALUES(?, 'pending')`, Date.now());
  q.run('INSERT INTO scheduled(due_at, payload) VALUES(?, ?)', Date.now() + 10 * 60000, JSON.stringify({
    title: '🍫 10 Minuten sind um',
    body: 'Wie sieht’s aus – ist die Lust weniger geworden?',
    tag: `craving-${id}`,
    data: { cravingId: id, url: '/#schoko' },
    actions: [{ action: 'resisted', title: '💪 Geschafft' }, { action: 'open', title: 'Öffnen' }],
  }));
  res.json({ id });
  broadcast('choc');
  ai.cravingCoach()
    .then((r) => q.run('UPDATE cravings SET ai = ? WHERE id = ?', JSON.stringify(r), id))
    .catch((e) => console.error('[craving]', e.message))
    .finally(() => broadcast('choc'));
}));

app.patch('/api/cravings/:id', wrap((req, res) => {
  if (req.body.trigger !== undefined) q.run('UPDATE cravings SET trigger = ? WHERE id = ?', req.body.trigger, req.params.id);
  if (req.body.outcome) q.run('UPDATE cravings SET outcome = ?, resolved_at = ? WHERE id = ?', req.body.outcome, Date.now(), req.params.id);
  broadcast('choc');
  broadcast('today');
  res.json({ ok: true });
}));

app.post('/api/choc/log', wrap((req, res) => {
  q.run(`INSERT INTO cravings(created_at, trigger, outcome, resolved_at) VALUES(?, 'log', 'ate', ?)`, Date.now(), Date.now());
  broadcast('choc');
  res.json({ ok: true });
}));

app.post('/api/choc/analyze', wrap((req, res) => {
  setSetting('choc_insight', JSON.stringify({ status: 'generating' }));
  res.json({ ok: true });
  broadcast('choc');
  ai.chocInsight()
    .then((r) => setSetting('choc_insight', JSON.stringify({ status: 'ready', ...r, at: Date.now() })))
    .catch((e) => setSetting('choc_insight', JSON.stringify({ status: 'error', error: e.message })))
    .finally(() => broadcast('choc'));
}));

// ======================= SETTINGS & PUSH =======================
const EDITABLE = ['name', 'morning_time', 'evening_time', 'bedtime', 'winddown_min'];
app.get('/api/settings', wrap((req, res) => {
  const s = getSettings();
  res.json({ ...Object.fromEntries(EDITABLE.map((k) => [k, s[k]])), profile: getProfile(), pushSubs: subscriptionCount() });
}));
app.put('/api/settings', wrap((req, res) => {
  for (const k of EDITABLE) if (req.body[k] != null) setSetting(k, req.body[k]);
  if (typeof req.body.profile === 'string') setProfile(req.body.profile);
  res.json({ ok: true });
}));

app.get('/api/push/key', (req, res) => res.json({ key: publicKey }));
app.post('/api/push/subscribe', wrap((req, res) => {
  if (!req.body?.endpoint) return res.status(400).json({ error: 'invalid' });
  saveSubscription(req.body);
  res.json({ ok: true });
}));
app.post('/api/push/test', wrap(async (req, res) => {
  const n = await sendPush({ title: 'MyLife 🔔', body: 'Benachrichtigungen funktionieren! So erinnere ich dich an Wichtiges.', tag: 'test', data: { url: '/#heute' } });
  res.json({ sent: n });
}));

// ======================= STATIC =======================
const pub = path.join(ROOT, 'public');
app.get('/sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'sw.js')); });
app.use(express.static(pub, { maxAge: 0 }));

app.listen(PORT, HOST, () => {
  console.log(`MyLife läuft auf http://${HOST}:${PORT}`);
  console.log(`Zugangsschlüssel: ${ACCESS_KEY}   (steht auch in data/access-key.txt)`);
  startScheduler();
});
