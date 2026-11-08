// Runs every 20 seconds: sends due reminders and the daily rhythm notifications.
import { q, json, dayKey, getSettings, getCheckin } from './db.js';
import { sendPush, subscriptionCount } from './push.js';
import { broadcast } from './bus.js';

const NAG_AFTER_MS = 30 * 60 * 1000; // remind once more if still open after 30 min
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

function once(key) {
  if (q.get('SELECT 1 FROM sent_log WHERE key = ?', key)) return false;
  q.run('INSERT INTO sent_log(key, at) VALUES(?, ?)', key, Date.now());
  return true;
}

export function itemPayload(item, again = false) {
  return {
    title: `${item.emoji || '🔔'} ${item.title}`,
    body: again ? 'Noch offen – kurz erledigen?' : (item.raw && item.raw !== item.title ? `„${item.raw}“` : 'Erinnerung'),
    tag: `item-${item.id}`,
    data: { itemId: item.id, url: '/#merken' },
    actions: [
      { action: 'done', title: '✅ Erledigt' },
      { action: 'snooze', title: '⏰ 15 Min' },
    ],
  };
}

async function tick() {
  const now = Date.now();

  // 1. reminders
  const due = q.all(`SELECT * FROM items WHERE status='open' AND processing=0 AND due_at IS NOT NULL AND due_at <= ? AND notified_at IS NULL`, now);
  for (const item of due) {
    q.run('UPDATE items SET notified_at = ? WHERE id = ?', now, item.id);
    await sendPush(itemPayload(item));
  }
  const nag = q.all(`SELECT * FROM items WHERE status='open' AND kind='reminder' AND notified_at IS NOT NULL AND nag_count < 1 AND notified_at <= ?`, now - NAG_AFTER_MS);
  for (const item of nag) {
    q.run('UPDATE items SET nag_count = nag_count + 1 WHERE id = ?', item.id);
    await sendPush(itemPayload(item, true));
  }
  if (due.length) broadcast('items');

  // 2. one-off scheduled pushes (e.g. craving follow-up)
  for (const s of q.all('SELECT * FROM scheduled WHERE sent = 0 AND due_at <= ?', now)) {
    q.run('UPDATE scheduled SET sent = 1 WHERE id = ?', s.id);
    const p = json(s.payload, {});
    if (p.data?.cravingId) {
      const c = q.get('SELECT outcome FROM cravings WHERE id = ?', p.data.cravingId);
      if (!c || c.outcome !== 'pending') continue;
    }
    await sendPush(p);
  }

  // 3. daily rhythm
  const st = getSettings();
  const d = new Date();
  const mins = d.getHours() * 60 + d.getMinutes();
  const day = dayKey(d);
  const daily = async (key, at, shouldSend, payload) => {
    const t = ((at % 1440) + 1440) % 1440;
    if (mins >= t && mins < t + 120 && subscriptionCount() > 0 && once(`${key}:${day}`) && shouldSend()) await sendPush(payload);
  };

  await daily('morning', toMin(st.morning_time), () => !getCheckin(day, 'morning'), {
    title: `Guten Morgen, ${st.name} ☀️`,
    body: '30 Sekunden Check-in – dann plane ich deinen Tag.',
    tag: 'morning',
    data: { url: '/#heute' },
  });
  await daily('evening', toMin(st.evening_time), () => !getCheckin(day, 'evening'), {
    title: 'Wie war dein Tag? 🌙',
    body: '1 Minute Abschluss – und ich sag dir, was heute gut war.',
    tag: 'evening',
    data: { url: '/#heute' },
  });
  const wind = Number(st.winddown_min) || 45;
  await daily('winddown', toMin(st.bedtime) - wind, () => true, {
    title: `In ${wind} Min ist Schlafenszeit 😴`,
    body: 'Zeit runterzufahren: Handy weg, Licht dimmen. Dein Morgen-Ich sagt danke.',
    tag: 'winddown',
    data: { url: '/#heute' },
  });
}

export function startScheduler() {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await tick(); } catch (e) { console.error('[scheduler]', e); } finally { busy = false; }
  };
  run();
  setInterval(run, 20000);
}
