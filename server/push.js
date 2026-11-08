import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, q } from './db.js';

const KEY_FILE = path.join(DATA_DIR, 'vapid.json');
let keys;
if (fs.existsSync(KEY_FILE)) {
  keys = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
} else {
  keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2));
}
webpush.setVapidDetails('mailto:mylife@example.com', keys.publicKey, keys.privateKey);

export const publicKey = keys.publicKey;

export function saveSubscription(sub) {
  q.run('INSERT INTO push_subs(endpoint, data, created_at) VALUES(?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data',
    sub.endpoint, JSON.stringify(sub), Date.now());
}

export function subscriptionCount() {
  return q.get('SELECT COUNT(*) AS n FROM push_subs').n;
}

/** payload: { title, body, tag, data: { url, itemId, cravingId }, actions: [{action, title}] } */
export async function sendPush(payload) {
  const subs = q.all('SELECT endpoint, data FROM push_subs');
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(JSON.parse(s.data), JSON.stringify(payload), { TTL: 60 * 60 * 6, urgency: 'high' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        q.run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint);
      } else {
        console.error('[push] failed:', e.statusCode, e.body || e.message);
      }
    }
  }));
  console.log(`[push] "${payload.title}" → ${sent}/${subs.length}`);
  return sent;
}
