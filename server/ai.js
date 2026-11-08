// The "brain": runs Claude Code headless on this PC.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, q, json, dayKey, addDays, getSettings, getProfile, getCheckin, getPlan } from './db.js';

const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const SANDBOX = path.join(DATA_DIR, 'ai-sandbox'); // empty cwd so no project files get loaded
fs.mkdirSync(SANDBOX, { recursive: true });

// ---------- process runner with a small queue ----------
const queue = [];
let running = 0;
const MAX_PARALLEL = 2;

export function runClaude({ prompt, schema, model, timeoutMs = 150000 }) {
  return new Promise((resolve, reject) => {
    queue.push({ prompt, schema, model: model || getSettings().model_fast, timeoutMs, resolve, reject });
    pump();
  });
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    running++;
    exec(job).then(job.resolve, job.reject).finally(() => { running--; pump(); });
  }
}

function exec({ prompt, schema, model, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--model', model];
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    const started = Date.now();
    const child = spawn(CLAUDE, args, { cwd: SANDBOX, windowsHide: true, env: process.env });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { child.kill(); reject(new Error('KI-Timeout')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(j.result || 'Claude-Fehler'));
        console.log(`[ai] ${model} ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        resolve(schema ? (j.structured_output ?? JSON.parse(j.result)) : j.result);
      } catch {
        reject(new Error(`claude exit ${code}: ${err.slice(0, 400)} ${out.slice(0, 400)}`));
      }
    });
    child.stdin.end(prompt, 'utf8');
  });
}

// ---------- shared context ----------
const AREAS = ['koerper', 'partnerschaft', 'familie', 'arbeit', 'kunst', 'alltag'];
const fmtNow = (d = new Date()) =>
  d.toLocaleString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
const fmtTime = (ms) =>
  new Date(ms).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

function persona() {
  const s = getSettings();
  return `Du bist der persönliche Lebens-Coach in der App „MyLife“ von ${s.name}.
Du sprichst Deutsch und duzt ${s.name}. Ton: warm, locker, gern mit einem Augenzwinkern, konkret und KURZ.
Nie belehrend, nie Schuldgefühle – Rückschläge sind normal und nur Daten. Kleine Schritte schlagen große Vorsätze.

## Profil (von ${s.name} selbst geschrieben)
${getProfile().trim() || '(noch leer)'}`;
}

function recentContext(days = 4) {
  const lines = [];
  for (let i = days; i >= 1; i--) {
    const d = dayKey(addDays(new Date(), -i));
    const m = getCheckin(d, 'morning');
    const e = getCheckin(d, 'evening');
    const p = getPlan(d);
    const parts = [];
    if (m) parts.push(`Schlaf ${m.data.sleep ?? '?'}h, Energie ${m.data.energy ?? '?'}/5`);
    if (p?.moments) parts.push('Momente: ' + p.moments.map((x) => `${x.done ? '✓' : '✗'} [${x.area}] ${x.text}`).join('; '));
    if (e) parts.push(`Abend: Stimmung ${e.data.mood ?? '?'}/5, Schoko ${e.data.choc ?? '?'}, Bewegung ${e.data.moved ? 'ja' : 'nein'}${e.data.note ? `, "${e.data.note}"` : ''}`);
    if (parts.length) lines.push(`- ${d}: ${parts.join(' | ')}`);
  }
  const since = addDays(new Date(), -7).getTime();
  const c = q.get(`SELECT COUNT(*) n, SUM(outcome='resisted') r, SUM(outcome='ate') a FROM cravings WHERE created_at > ?`, since);
  lines.push(`- Schoko-Cravings letzte 7 Tage: ${c.n} (widerstanden ${c.r || 0}, gegessen ${c.a || 0})`);
  const open = q.all(`SELECT title, due_at FROM items WHERE status='open' AND processing=0 AND kind!='note' ORDER BY due_at IS NULL, due_at LIMIT 12`);
  if (open.length) lines.push('- Offene Aufgaben: ' + open.map((o) => o.title + (o.due_at ? ` (${fmtTime(o.due_at)})` : '')).join('; '));
  return lines.join('\n') || '(noch keine Daten – die App ist neu)';
}

// ---------- 1. Inbox: free text → structured items ----------
const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: ['reminder', 'todo', 'note'] },
          area: { type: 'string', enum: AREAS },
          emoji: { type: 'string' },
          due_local: { type: ['string', 'null'], description: 'YYYY-MM-DDTHH:MM lokale Zeit oder null' },
        },
        required: ['title', 'kind', 'area', 'emoji', 'due_local'],
      },
    },
  },
  required: ['items'],
};

export async function parseInbox(text) {
  const prompt = `Du bist der Sortier-Assistent der App „MyLife“. Wandle die Nachricht in einen oder mehrere Einträge um.
Jetzt ist: ${fmtNow()} (lokale Zeit).

Regeln:
- kind "reminder" = es soll zu einem Zeitpunkt eine Handy-Benachrichtigung kommen. "todo" = Aufgabe ohne konkreten Zeitpunkt. "note" = Idee/Info zum Merken, keine Aufgabe.
- Wenn gerade etwas gestartet wurde, schätze klug, wann es fertig ist: Waschmaschine ≈ 2 Std → "Wäsche aus der Maschine holen", Trockner ≈ 2,5 Std, Spülmaschine ≈ 2,5 Std, Essen im Ofen ohne Angabe ≈ 30 Min, Tee ≈ 4 Min, Nudeln ≈ 10 Min.
- Relative Angaben: "morgen früh" = 08:00, "mittags" = 12:00, "nachmittags" = 15:00, "heute Abend"/"abends" = 19:00, "nachher" = in 1 Std, "später" = in 2 Std. Ohne Uhrzeit, aber mit Tag ("Freitag Oma anrufen") → 10:00 an dem Tag.
- Termine (z.B. "Elternabend Donnerstag 19 Uhr"): Erinnerung VOR dem Termin (Termine ab 12 Uhr: 1 Std vorher; Termine vor 12 Uhr: am Vorabend 20:00). Uhrzeit des Termins in den Titel, aber ohne "heute"/"morgen" (z.B. "Elternabend um 19 Uhr").
- "Ich muss X" ohne Zeit und ohne Dringlichkeit → todo. Klingt es nach "heute noch" → reminder heute zu einer sinnvollen Zeit (mindestens 1 Std ab jetzt, nicht später als 21:00; ist es schon später, dann morgen 09:00).
- Mehrere Dinge in einer Nachricht → mehrere Einträge.
- title: kurz, als Handlungsaufforderung, wie eine Benachrichtigung ("Wäsche aus der Maschine holen"), max. 60 Zeichen, Deutsch.
- area: koerper | partnerschaft | familie (auch Kinder) | arbeit | kunst | alltag. emoji: ein passendes Emoji.
- due_local nur bei reminder, sonst null.

Nachricht: """${text}"""`;
  const r = await runClaude({ prompt, schema: ITEM_SCHEMA });
  return r.items;
}

// ---------- 2. Morning plan ----------
const MOMENT = {
  type: 'object',
  properties: {
    area: { type: 'string', enum: AREAS },
    emoji: { type: 'string' },
    text: { type: 'string', description: 'konkret, max. 90 Zeichen' },
  },
  required: ['area', 'emoji', 'text'],
};
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    greeting: { type: 'string', description: '1–2 kurze Sätze' },
    moments: { type: 'array', items: MOMENT, minItems: 3, maxItems: 3 },
    tip: { type: 'string', description: 'ein kurzer Satz, optional leer' },
  },
  required: ['greeting', 'moments', 'tip'],
};

const MOMENT_RULES = `Regeln für Momente:
- Klein und machbar: je max. 20 Minuten, sehr konkret ("10 Kniebeugen nach dem Zähneputzen" statt "Sport machen").
- Mische die Lebensbereiche und bevorzuge Bereiche, die in den letzten Tagen zu kurz kamen oder nicht geschafft wurden.
- Mindestens ein Moment für Partnerschaft oder Familie.
- Passe dich an Schlaf, Energie und Wochentag an (Werktag: Arbeit ist ein Thema; Wochenende: mehr Familie/Kunst/Bewegung draußen).
- Wenig Schlaf (< 7h) oder wenig Energie: sanfte Momente, und einer davon hilft, heute früher ins Bett zu kommen.
- Partnerschaft: kleine Gesten, echte Zeit zu zweit ohne Handy, Komplimente, Berührung, Flirten, Date-Ideen – charmant, nie plump.
- Familie: Zeit mit den Kindern (Alter unbekannt – halte es allgemein).
- Kunst: kleine kreative Übungen (Skizze, 10-Minuten-Übung, Inspiration sammeln).
- Arbeit: ein klarer Fokus-Schritt.
- Wiederhole nicht wörtlich Momente der letzten Tage.`;

export async function morningPlan(checkin) {
  const prompt = `${persona()}

## Letzte Tage
${recentContext()}

## Jetzt
${fmtNow()}
${checkin ? `Morgen-Check-in: Schlaf ${checkin.sleep ?? '?'} Std, Energie ${checkin.energy ?? '?'}/5${checkin.note ? `, Notiz: "${checkin.note}"` : ''}` : 'Kein Check-in heute.'}

## Aufgabe
Plane den Tag: eine kurze persönliche Begrüßung (Bezug auf Schlaf/Energie/Tag), genau 3 Momente für heute und optional ein kurzer Tipp.

${MOMENT_RULES}`;
  return runClaude({ prompt, schema: PLAN_SCHEMA, model: getSettings().model_smart });
}

export async function swapMoment(plan, index) {
  const others = plan.moments.map((m, i) => `${i === index ? 'ERSETZEN' : 'behalten'}: [${m.area}] ${m.text}`).join('\n');
  const prompt = `${persona()}

## Letzte Tage
${recentContext(3)}

## Jetzt
${fmtNow()}

## Aufgabe
Heutige Momente:
${others}

Schlage EINEN neuen Moment vor, der den markierten ersetzt. Anders als alle obigen, gern ein anderer Bereich.

${MOMENT_RULES}`;
  return runClaude({ prompt, schema: MOMENT });
}

// ---------- 3. Evening reflection ----------
export async function eveningReply(data, plan) {
  const prompt = `${persona()}

## Letzte Tage
${recentContext(3)}

## Heute (${fmtNow()})
Momente: ${plan?.moments ? plan.moments.map((m) => `${m.done ? '✓' : '✗'} ${m.text}`).join('; ') : 'kein Plan'}
Abend-Check-in: Stimmung ${data.mood ?? '?'}/5, Schoko: ${{ none: 'keine', little: 'ein bisschen', lots: 'viel' }[data.choc] ?? '?'}, Bewegung: ${data.moved ? 'ja' : 'nein'}${data.note ? `, Notiz: "${data.note}"` : ''}

## Aufgabe
Antworte mit 2–3 kurzen Sätzen: würdige, was heute gut war (konkret!), und gib einen kleinen Gedanken für morgen. Keine Schoko heute → feiern. Viel Schoko → verständnisvoll + ein Mini-Tipp. Denk an den Schlaf.`;
  return runClaude({ prompt, schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] } });
}

// ---------- 4. Chocolate craving ----------
export async function cravingCoach() {
  const since = addDays(new Date(), -14).getTime();
  const log = q.all(`SELECT created_at, trigger, outcome FROM cravings WHERE created_at > ? ORDER BY created_at DESC LIMIT 20`, since)
    .map((c) => `${fmtTime(c.created_at)} ${c.trigger || ''} → ${c.outcome}`).join('\n');
  const prompt = `${persona()}

## Situation
Jetzt (${fmtNow()}) hat ${getSettings().name} gerade starke Lust auf Schokolade und hat den Notfall-Button gedrückt. Ein 10-Minuten-Timer läuft.
Bisherige Cravings (neueste zuerst):
${log || '(keine)'}

## Aufgabe
- message: max. 2 kurze Sätze, die JETZT helfen. Ermutigend, ggf. mit Bezug auf Uhrzeit oder Muster. Kein Vortrag.
- alternative: EINE konkrete Ersatzhandlung für genau jetzt, max. 6 Wörter, mit Emoji (z.B. "🍵 Einen Tee kochen", "🚶 2 Minuten raus an die Luft").`;
  return runClaude({
    prompt,
    schema: { type: 'object', properties: { message: { type: 'string' }, alternative: { type: 'string' } }, required: ['message', 'alternative'] },
  });
}

export async function chocInsight() {
  const since = addDays(new Date(), -30).getTime();
  const log = q.all(`SELECT created_at, trigger, outcome FROM cravings WHERE created_at > ? ORDER BY created_at`, since)
    .map((c) => `${fmtTime(c.created_at)} | Auslöser: ${c.trigger || '?'} | ${c.outcome}`).join('\n');
  const days = q.all(`SELECT day, data FROM checkins WHERE type='evening' AND created_at > ? ORDER BY day`, since)
    .map((r) => `${r.day}: Schoko ${json(r.data, {}).choc}`).join(', ');
  const prompt = `${persona()}

## Schoko-Daten der letzten 30 Tage
Cravings:
${log || '(keine)'}
Abend-Angaben: ${days || '(keine)'}

## Aufgabe
Finde Muster (Uhrzeiten, Wochentage, Auslöser, was klappt). insight: 2–3 Sätze, konkret mit Zahlen. tips: genau 3 konkrete, kleine Strategien, die genau auf diese Muster passen (z.B. Umfeld ändern, Ersatz vorbereiten, Auslöser entschärfen).`;
  return runClaude({
    prompt,
    model: getSettings().model_smart,
    schema: {
      type: 'object',
      properties: { insight: { type: 'string' }, tips: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 } },
      required: ['insight', 'tips'],
    },
  });
}
