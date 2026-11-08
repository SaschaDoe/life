import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const BRAIN_DIR = path.join(ROOT, 'brain');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BRAIN_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'mylife.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw TEXT,
  title TEXT,
  kind TEXT DEFAULT 'todo',          -- reminder | todo | note
  area TEXT DEFAULT 'alltag',
  emoji TEXT,
  due_at INTEGER,                    -- epoch ms
  status TEXT DEFAULT 'open',        -- open | done
  processing INTEGER DEFAULT 0,
  notified_at INTEGER,
  nag_count INTEGER DEFAULT 0,
  created_at INTEGER,
  done_at INTEGER
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT, type TEXT, data TEXT, ai TEXT, created_at INTEGER,
  UNIQUE(day, type)
);
CREATE TABLE IF NOT EXISTS plans (day TEXT PRIMARY KEY, data TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS cravings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER, trigger TEXT, intensity INTEGER,
  outcome TEXT DEFAULT 'pending',    -- pending | resisted | ate
  resolved_at INTEGER, ai TEXT
);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, data TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sent_log (key TEXT PRIMARY KEY, at INTEGER);
CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT, due_at INTEGER, payload TEXT, sent INTEGER DEFAULT 0
);
`);

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => {
    const r = db.prepare(sql).run(...p);
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  },
};

// ---------- helpers ----------
export const pad = (n) => String(n).padStart(2, '0');
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function json(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---------- settings ----------
const DEFAULTS = {
  name: 'Sascha',
  morning_time: '07:00',
  evening_time: '21:00',
  bedtime: '23:00',
  winddown_min: '45',
  model_fast: 'sonnet',
  model_smart: 'opus',
};
export function getSettings() {
  const out = { ...DEFAULTS };
  for (const r of q.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}
export function setSetting(key, value) {
  q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

// ---------- profile (the AI reads this) ----------
const PROFILE_FILE = path.join(BRAIN_DIR, 'profile.md'); // personal – not in git
const PROFILE_EXAMPLE = path.join(BRAIN_DIR, 'profile.example.md');
if (!fs.existsSync(PROFILE_FILE) && fs.existsSync(PROFILE_EXAMPLE)) fs.copyFileSync(PROFILE_EXAMPLE, PROFILE_FILE);
export function getProfile() {
  try { return fs.readFileSync(PROFILE_FILE, 'utf8'); } catch { return ''; }
}
export function setProfile(text) {
  fs.writeFileSync(PROFILE_FILE, text, 'utf8');
}

// ---------- domain reads ----------
export function getCheckin(day, type) {
  const r = q.get('SELECT * FROM checkins WHERE day = ? AND type = ?', day, type);
  return r ? { ...r, data: json(r.data, {}), ai: json(r.ai) } : null;
}
export function getPlan(day) {
  const r = q.get('SELECT * FROM plans WHERE day = ?', day);
  return r ? json(r.data) : null;
}
export function savePlan(day, data) {
  q.run('INSERT INTO plans(day, data, created_at) VALUES(?, ?, ?) ON CONFLICT(day) DO UPDATE SET data = excluded.data',
    day, JSON.stringify(data), Date.now());
}
export function itemRow(r) {
  return r ? { ...r, processing: !!r.processing } : null;
}
