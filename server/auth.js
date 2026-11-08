// Simple single-user auth: a random access key (data/access-key.txt) → HttpOnly session cookie.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const KEY_FILE = path.join(DATA_DIR, 'access-key.txt');
const SECRET_FILE = path.join(DATA_DIR, 'session-secret.txt');
const COOKIE = 'mylife_session';
const MAX_AGE_S = 60 * 60 * 24 * 365; // stay logged in for a year

function readOrCreate(file, make) {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const v = make();
  fs.writeFileSync(file, v + '\n');
  return v;
}

// human-friendly key, e.g. "7Q4M-ZX9P-2LTB-K8WD"
export const ACCESS_KEY = readOrCreate(KEY_FILE, () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from(crypto.randomBytes(4), (b) => abc[b % abc.length]).join('');
  return `${part()}-${part()}-${part()}-${part()}`;
});
const SECRET = readOrCreate(SECRET_FILE, () => crypto.randomBytes(32).toString('hex'));

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const token = () => { const v = `v1.${Date.now()}`; return `${v}.${sign(v)}`; };
function valid(t) {
  if (!t) return false;
  const i = t.lastIndexOf('.');
  const v = t.slice(0, i), s = t.slice(i + 1);
  const exp = Buffer.from(sign(v)), got = Buffer.from(s);
  return exp.length === got.length && crypto.timingSafeEqual(exp, got);
}
function readCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// brute-force protection: max 10 failed attempts per 15 min per IP
const fails = new Map();
const clientIp = (req) => String(req.headers['x-nf-client-connection-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();

export function loginHandler(req, res) {
  const ip = clientIp(req);
  const f = fails.get(ip);
  if (f && f.n >= 10 && Date.now() - f.t < 15 * 60000) return res.status(429).json({ error: 'Zu viele Versuche – warte 15 Minuten.' });
  const key = String(req.body?.key || '').trim().toUpperCase();
  if (!safeEqual(key, ACCESS_KEY)) {
    fails.set(ip, { n: (f && Date.now() - f.t < 15 * 60000 ? f.n : 0) + 1, t: Date.now() });
    return res.status(401).json({ error: 'Falscher Schlüssel' });
  }
  fails.delete(ip);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token())}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}

export function logoutHandler(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
}

export function requireAuth(req, res, next) {
  if (valid(readCookie(req))) return next();
  res.status(401).json({ error: 'login' });
}
