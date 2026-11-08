// MyLife – client
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    setOffline(true);
    throw new Error('Keine Verbindung zum PC');
  }
  // Netlify answers 5xx / HTML when the PC is off or the tunnel is down
  const isJson = (r.headers.get('content-type') || '').includes('application/json');
  if (r.status >= 502 || (!isJson && path !== '/login')) { setOffline(true); throw new Error('PC nicht erreichbar'); }
  setOffline(false);
  if (r.status === 401 && path !== '/login') { S.needLogin = true; render(); throw new Error('Bitte anmelden'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
function setOffline(v) {
  if (S.offline === v) return;
  S.offline = v;
  render();
}

const TABS = ['heute', 'merken', 'schoko', 'einstellungen'];
const S = {
  tab: 'heute',
  today: null, items: null, choc: null, settings: null,
  push: { supported: 'serviceWorker' in navigator && 'PushManager' in window, subscribed: false },
  form: {
    capture: '',
    morning: { sleep: null, energy: null, note: '' },
    evening: { mood: null, choc: null, moved: null, note: '' },
  },
  sheet: null, // { type: 'capture' | 'edit', item }
  needLogin: false,
  offline: false,
};

// ---------- formatting ----------
const pad = (n) => String(n).padStart(2, '0');
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / 86400000);
const timeStr = (d) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
function dueLabel(ms) {
  const d = new Date(ms);
  const dd = dayDiff(d, new Date());
  if (dd === 0) return `heute ${timeStr(d)}`;
  if (dd === 1) return `morgen ${timeStr(d)}`;
  if (dd === -1) return `gestern ${timeStr(d)}`;
  if (dd > 1 && dd < 7) return `${d.toLocaleDateString('de-DE', { weekday: 'long' })} ${timeStr(d)}`;
  return `${d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })} ${timeStr(d)}`;
}
const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function greet() {
  const h = new Date().getHours();
  if (h < 5) return 'Gute Nacht';
  if (h < 11) return 'Guten Morgen';
  if (h < 17) return 'Hallo';
  if (h < 22) return 'Guten Abend';
  return 'Gute Nacht';
}

// ---------- toast & sheet ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
function openSheet(sheet) { S.sheet = sheet; renderSheet(); }
function closeSheet() { S.sheet = null; stopMic(); $('#sheet-backdrop').hidden = true; }

// ================= VIEWS =================
const chip = (group, value, label, current, cls = '') =>
  `<button class="chip ${cls} ${current === value ? 'on' : ''}" data-action="pick" data-group="${group}" data-value="${esc(JSON.stringify(value))}">${label}</button>`;

function itemRow(it) {
  if (it.processing) {
    return `<li class="item processing"><div class="spinner"></div><div class="i-main"><div class="i-title">${esc(it.raw)}</div><div class="i-meta">✨ KI sortiert…</div></div></li>`;
  }
  const overdue = it.status === 'open' && it.due_at && it.due_at < Date.now();
  const meta = it.due_at ? `${overdue ? '⚠️ ' : '⏰ '}${dueLabel(it.due_at)}` : (it.kind === 'note' ? '💭 Notiz' : '');
  return `<li class="item ${it.status === 'done' ? 'done' : ''}">
    <button class="check" data-action="toggleItem" data-id="${it.id}" aria-label="Erledigt"></button>
    <div class="i-main" data-action="editItem" data-id="${it.id}">
      <div class="i-title">${esc(it.emoji || '')} ${esc(it.title)}</div>
      ${meta ? `<div class="i-meta ${overdue ? 'overdue' : ''}">${meta}</div>` : ''}
    </div></li>`;
}

function captureBox() {
  return `<div class="capture">
    <textarea data-bind="capture" rows="2" placeholder="Was ist los? z.B. „Waschmaschine läuft“">${esc(S.form.capture)}</textarea>
    <button class="mic ${rec ? 'on' : ''}" data-action="mic" aria-label="Sprechen">🎙️</button>
    <button class="send" data-action="sendCapture" aria-label="Senden">➤</button>
  </div>`;
}

function pushBanner() {
  if (!S.push.supported) {
    return `<section class="card"><h2>🔔 Benachrichtigungen</h2><p class="muted small">Push geht nur über die sichere Adresse (https://…ts.net). Öffne die App über Tailscale.</p></section>`;
  }
  if (S.push.subscribed) return '';
  return `<section class="card accent"><h2>🔔 Erinnerungen einschalten</h2>
    <p class="muted small" style="margin:0">Damit ich dich an die Wäsche, deinen Check-in & Schlafenszeit erinnern kann.</p>
    <button class="btn block" style="background:#fff;color:#c2410c" data-action="enablePush">Jetzt aktivieren</button></section>`;
}

function weekStrip(cw, link = true) {
  const today = cw.days[cw.days.length - 1].day;
  return `<div class="week">${cw.days.map((d) => `<div class="wd"><div class="dot ${d.status} ${d.day === today ? 'today' : ''}">${d.status === 'none' ? '✓' : ''}</div>${esc(d.wd)}</div>`).join('')}</div>
    ${link ? '' : ''}`;
}

// ---------- HEUTE ----------
function viewHeute() {
  const t = S.today;
  if (!t) return skeleton();
  const h = new Date().getHours();
  let html = `<header class="hero"><div class="hello">${greet()}, ${esc(t.name)}</div>
    <div class="date">${new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}</div></header>`;
  html += pushBanner();

  // plan / morning check-in
  if (t.plan) html += planCard(t.plan);
  else if (!t.morning) html += morningCard();

  // due today
  if (t.due.length) {
    html += `<section class="card"><h2>⏰ Heute dran <span class="sub">${t.due.length}</span></h2><ul class="items">${t.due.map(itemRow).join('')}</ul></section>`;
  }

  // evening
  if (t.evening) {
    html += `<section class="card"><h2>🌙 Tagesabschluss</h2>${
      t.evening.ai?.reply ? `<p style="margin:0">${esc(t.evening.ai.reply)}</p>` : `<div class="thinking"><div class="spinner"></div>Ich lese deinen Tag…</div>`
    }</section>`;
  } else if (h >= 17) {
    html += eveningCard();
  }

  // chocolate week
  html += `<section class="card" data-action="go" data-tab="schoko" style="cursor:pointer">
    <h2>🍫 Schoko-Woche <span class="sub">${t.chocWeek.streak ? `${t.chocWeek.streak} ${t.chocWeek.streak === 1 ? 'Tag' : 'Tage'} frei 🔥` : '›'}</span></h2>
    ${weekStrip(t.chocWeek)}</section>`;
  return html;
}

function morningCard() {
  const f = S.form.morning;
  return `<section class="card"><h2>☀️ Morgen-Check-in <span class="sub">30 Sek.</span></h2>
    <label class="q">Wie lange hast du geschlafen?</label>
    <div class="chips">${[[5, '≤ 5 h'], [6, '6 h'], [7, '7 h'], [8, '8 h'], [9, '9+ h']].map(([v, l]) => chip('morning.sleep', v, l, f.sleep)).join('')}</div>
    <label class="q">Wie fit fühlst du dich?</label>
    <div class="chips">${['🪫', '😴', '😐', '🙂', '⚡'].map((e, i) => chip('morning.energy', i + 1, e, f.energy, 'emoji')).join('')}</div>
    <label class="q">Was steht heute an? <span class="muted small">(optional)</span></label>
    <textarea data-bind="morning.note" rows="2" placeholder="z.B. viele Meetings, Kinder haben frei…">${esc(f.note)}</textarea>
    <button class="btn primary block" data-action="submitMorning">Tag planen ✨</button>
    <button class="btn ghost block" style="margin-top:4px" data-action="planWithout">Ohne Check-in planen</button>
  </section>`;
}

function planCard(p) {
  if (p.status === 'generating') {
    return `<section class="card"><h2>✨ Dein Tag</h2><div class="thinking"><div class="spinner"></div>Ich plane deinen Tag…</div>
      <div class="shimmer"></div><div class="shimmer" style="width:80%"></div><div class="shimmer" style="width:60%"></div></section>`;
  }
  if (p.status === 'error') {
    return `<section class="card"><h2>✨ Dein Tag</h2><p class="muted">Hoppla, das Planen hat nicht geklappt.</p>
      <button class="btn block" data-action="regenPlan">Nochmal versuchen</button></section>`;
  }
  const done = p.moments.filter((m) => m.done).length;
  return `<section class="card"><h2>✨ Deine 3 Momente <span class="sub">${done}/3</span></h2>
    <p class="greeting">${esc(p.greeting)}</p>
    <ul class="moments">${p.moments.map((m, i) => `<li class="moment ${m.done ? 'done' : ''}">
      <button class="check" data-action="toggleMoment" data-i="${i}" aria-label="Geschafft"></button>
      <span class="m-emoji">${esc(m.emoji)}</span><span class="m-text">${esc(m.text)}</span>
      ${m.done ? '' : m.swapping ? '<div class="spinner"></div>' : `<button class="icon-btn" data-action="swapMoment" data-i="${i}" aria-label="Anderer Vorschlag" title="Anderer Vorschlag">↻</button>`}
    </li>`).join('')}</ul>
    <div class="progress"><div style="width:${(done / 3) * 100}%"></div></div>
    ${p.tip ? `<p class="tip">💡 ${esc(p.tip)}</p>` : ''}
    ${done === 3 ? '<p class="tip">🎉 Alle drei geschafft – richtig stark!</p>' : ''}
  </section>`;
}

function eveningCard() {
  const f = S.form.evening;
  return `<section class="card"><h2>🌙 Wie war dein Tag? <span class="sub">1 Min.</span></h2>
    <label class="q">Stimmung</label>
    <div class="chips">${['😞', '😕', '😐', '🙂', '😄'].map((e, i) => chip('evening.mood', i + 1, e, f.mood, 'emoji')).join('')}</div>
    <label class="q">Schoko heute?</label>
    <div class="chips">${chip('evening.choc', 'none', 'Keine 🎉', f.choc)}${chip('evening.choc', 'little', 'Ein bisschen', f.choc)}${chip('evening.choc', 'lots', 'Viel', f.choc)}</div>
    <label class="q">Bewegt?</label>
    <div class="chips">${chip('evening.moved', true, 'Ja 🏃', f.moved)}${chip('evening.moved', false, 'Nö', f.moved)}</div>
    <label class="q">Was war heute schön? <span class="muted small">(optional)</span></label>
    <textarea data-bind="evening.note" rows="2" placeholder="Ein Moment, ein Gefühl, ein Satz…">${esc(f.note)}</textarea>
    <button class="btn primary block" data-action="submitEvening">Tag abschließen 🌙</button>
  </section>`;
}

// ---------- MERKEN ----------
function viewMerken() {
  let html = `<header class="page-h"><h1>📝 Merken</h1><p>Sag einfach, was los ist – ich kümmere mich um den Rest.</p></header>
    <section class="card">${captureBox()}
    <div class="examples">z.B. „Waschmaschine läuft“ · „Freitag Oma anrufen“ · „Elternabend Do 19 Uhr“</div></section>`;
  const it = S.items;
  if (!it) return html + skeleton();
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const processing = it.open.filter((x) => x.processing);
  const today = it.open.filter((x) => !x.processing && x.due_at && x.due_at <= endToday);
  const later = it.open.filter((x) => !x.processing && x.due_at && x.due_at > endToday);
  const todos = it.open.filter((x) => !x.processing && !x.due_at && x.kind !== 'note');
  const notes = it.open.filter((x) => !x.processing && !x.due_at && x.kind === 'note');
  const section = (title, list) => list.length ? `<section class="card"><h2>${title} <span class="sub">${list.length}</span></h2><ul class="items">${list.map(itemRow).join('')}</ul></section>` : '';
  html += section('✨ Wird sortiert', processing);
  html += section('⏰ Heute', today);
  html += section('📅 Demnächst', later);
  html += section('✅ To-dos', todos);
  html += section('💭 Notizen & Ideen', notes);
  if (!it.open.length) html += `<div class="empty"><div class="e">🌿</div>Alles erledigt. Kopf frei!</div>`;
  if (it.done.length) {
    html += `<section class="card"><details class="done-list"><summary>Erledigt (${it.done.length}) ›</summary><ul class="items">${it.done.map(itemRow).join('')}</ul></details></section>`;
  }
  return html;
}

// ---------- SCHOKO ----------
const TRIGGERS = ['Stress', 'Langeweile', 'Müde', 'Hunger', 'Belohnung', 'Gewohnheit', 'Frust', 'Gesellschaft'];
const STATIC_TIPS = [
  'Atme tief durch. Die Lust kommt in Wellen – und jede Welle geht vorbei. 🌊',
  'Ein großes Glas Wasser trinken. Oft ist es Durst oder Müdigkeit.',
  'Die Lust ist am stärksten in den ersten Minuten. Du schaffst das.',
  'Steh kurz auf und geh in einen anderen Raum. Ortswechsel hilft.',
];
const CRAVE_MS = 10 * 60000;

function viewSchoko() {
  const c = S.choc;
  if (!c) return `<header class="page-h"><h1>🍫 Schoko</h1></header>` + skeleton();
  let html = `<header class="page-h"><h1>🍫 Schoko</h1><p>Weniger ist das Ziel – nicht Perfektion.</p></header>`;

  if (c.active) {
    const a = c.active;
    const tip = STATIC_TIPS[a.id % STATIC_TIPS.length];
    html += `<section class="card">
      <div class="ring" id="ring"><div class="ring-inner"><div><div class="ring-time" id="ring-time">10:00</div><div class="ring-label">durchhalten</div></div></div></div>
      ${a.ai ? `<p class="coach">${esc(a.ai.message)}</p><div class="alt">Jetzt stattdessen: <b>${esc(a.ai.alternative)}</b></div>`
             : `<p class="coach">${esc(tip)}</p><div class="thinking" style="justify-content:center"><div class="spinner"></div>Dein Coach kommt…</div>`}
      <label class="q">Was ist der Auslöser? <span class="muted small">(hilft, Muster zu finden)</span></label>
      <div class="chips">${TRIGGERS.map((t) => `<button class="chip ${a.trigger === t ? 'on' : ''}" data-action="setTrigger" data-value="${t}">${t}</button>`).join('')}</div>
      <div class="row" style="margin-top:16px">
        <button class="btn primary" data-action="resolveCraving" data-outcome="resisted">Lust ist weg 💪</button>
        <button class="btn" data-action="resolveCraving" data-outcome="ate">Hab gegessen</button>
      </div></section>`;
  } else {
    html += `<button class="craving-btn" data-action="startCraving"><div class="big">🍫</div><span>Ich hab gerade Lust drauf</span><small>Tippen – ich helf dir durch die nächsten 10 Minuten</small></button>`;
  }

  html += `<section class="card"><h2>📆 Diese Woche</h2>
    <div class="streak"><b>${c.streak}</b><span class="muted">${c.streak === 1 ? 'Tag' : 'Tage'} schokofrei in Folge</span></div>
    ${weekStrip(c, false)}
    <p class="small muted" style="margin:12px 0 0">${c.week.total ? `${c.week.resisted} von ${c.week.total} Cravings widerstanden ${c.week.resisted ? '💪' : ''}` : 'Noch keine Cravings diese Woche erfasst.'}
    <br>🟢 frei · 🟡 bisschen · 🔴 viel · ⚪ noch offen (kommt aus dem Abend-Check-in)</p></section>`;

  const max = Math.max(1, ...c.hours);
  html += `<section class="card"><h2>🕐 Wann kommt die Lust? <span class="sub">30 Tage</span></h2>
    ${c.total30 ? `<div class="bars">${c.hours.map((n, h) => `<div class="${n ? '' : 'zero'}" style="height:${Math.max(2, (n / max) * 100)}%" title="${h} Uhr: ${n}"></div>`).join('')}</div>
    <div class="bar-labels"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div>`
    : '<p class="muted small" style="margin:0">Sobald du den Button ein paar Mal genutzt hast, siehst du hier deine Muster.</p>'}</section>`;

  const ins = c.insight;
  html += `<section class="card"><h2>🔍 Deine Muster</h2>`;
  if (ins?.status === 'generating') html += `<div class="thinking"><div class="spinner"></div>Ich analysiere deine Daten…</div>`;
  else if (ins?.status === 'ready') html += `<p style="margin:0">${esc(ins.insight)}</p><ul class="tips">${ins.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
  else if (ins?.status === 'error') html += `<p class="muted">Analyse fehlgeschlagen – versuch’s nochmal.</p>`;
  else html += `<p class="muted small" style="margin:0">Ab 3 erfassten Cravings kann ich Muster für dich finden.</p>`;
  html += `<button class="btn block" data-action="analyzeChoc" ${c.total30 < 3 || ins?.status === 'generating' ? 'disabled' : ''}>Muster analysieren ✨</button></section>`;

  html += `<button class="btn ghost block" data-action="logAte">Schoko gegessen, ohne vorher zu drücken? Ehrlich eintragen</button>`;
  return html;
}

// ---------- EINSTELLUNGEN ----------
function viewEinstellungen() {
  const s = S.settings;
  if (!s) return skeleton();
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return `<header class="page-h"><h1>⚙️ Einstellungen</h1></header>
    <section class="card"><h2>🔔 Benachrichtigungen</h2>
      <p class="small muted" style="margin:0 0 10px">${!S.push.supported ? 'Hier nicht verfügbar – öffne die App über die https://…ts.net-Adresse.'
        : S.push.subscribed ? 'Aktiv auf diesem Gerät ✅' : perm === 'denied' ? 'Blockiert – in den Chrome-Seiteneinstellungen erlauben.' : 'Noch nicht aktiv.'}
        · ${s.pushSubs} Gerät(e) verbunden</p>
      <div class="row">${S.push.subscribed ? '' : '<button class="btn primary" data-action="enablePush">Aktivieren</button>'}
      <button class="btn" data-action="testPush">Test senden</button></div>
    </section>
    <section class="card"><h2>🕐 Dein Rhythmus</h2>
      <div class="field"><label>Dein Name</label><input type="text" id="s-name" value="${esc(s.name)}"></div>
      <div class="grid2">
        <div class="field"><label>Morgen-Check-in</label><input type="time" id="s-morning" value="${esc(s.morning_time)}"></div>
        <div class="field"><label>Abend-Check-in</label><input type="time" id="s-evening" value="${esc(s.evening_time)}"></div>
        <div class="field"><label>Schlafenszeit</label><input type="time" id="s-bed" value="${esc(s.bedtime)}"></div>
        <div class="field"><label>Erinnerung vorher (Min)</label><input type="number" id="s-wind" min="0" max="180" value="${esc(s.winddown_min)}"></div>
      </div>
    </section>
    <section class="card"><h2>🧠 Über mich</h2>
      <p class="small muted" style="margin:0 0 8px">Das liest die KI bei jedem Vorschlag. Je ehrlicher, desto besser die Tipps.</p>
      <textarea id="s-profile" rows="14">${esc(s.profile)}</textarea>
    </section>
    <button class="btn primary block" data-action="saveSettings">Speichern</button>
    <p class="small muted" style="text-align:center;margin-top:18px">Tipp: Chrome-Menü ⋮ → „Zum Startbildschirm hinzufügen“, dann fühlt sich MyLife wie eine echte App an.</p>
    <button class="btn ghost block" data-action="logout">Auf diesem Gerät abmelden</button>`;
}

const skeleton = () => `<section class="card"><div class="shimmer"></div><div class="shimmer" style="width:70%"></div><div class="shimmer" style="width:85%"></div></section>`;

// ================= SHEET =================
function renderSheet() {
  const bd = $('#sheet-backdrop');
  const sh = $('#sheet');
  if (!S.sheet) { bd.hidden = true; return; }
  if (S.sheet.type === 'capture') {
    sh.innerHTML = `<h3>Was soll ich mir merken?</h3>${captureBox()}
      <div class="examples">Einfach sprechen: „Waschmaschine läuft“, „morgen früh Bäcker“, „Idee: Aquarell vom Garten“</div>`;
  } else if (S.sheet.type === 'edit') {
    const it = S.sheet.item;
    sh.innerHTML = `<h3>${esc(it.emoji || '📝')} Bearbeiten</h3>
      <div class="field"><label>Titel</label><input type="text" id="e-title" value="${esc(it.title)}"></div>
      <div class="field"><label>Erinnerung</label><input type="datetime-local" id="e-due" value="${it.due_at ? toLocalInput(it.due_at) : ''}"></div>
      <div class="chips" style="margin-top:10px">
        <button class="chip" data-action="quickDue" data-min="15">+15 Min</button>
        <button class="chip" data-action="quickDue" data-min="60">+1 Std</button>
        <button class="chip" data-action="quickDue" data-tomorrow="1">Morgen 9:00</button>
        <button class="chip" data-action="quickDue" data-clear="1">Keine Zeit</button>
      </div>
      ${it.raw && it.raw !== it.title ? `<p class="small muted">Du hast gesagt: „${esc(it.raw)}“</p>` : ''}
      <button class="btn primary block" data-action="saveItem">Speichern</button>
      <div class="row" style="margin-top:8px"><button class="btn danger" data-action="deleteItem">Löschen</button><button class="btn" data-action="closeSheet">Abbrechen</button></div>`;
  }
  bd.hidden = false;
}

// ================= RENDER / DATA =================
function viewLogin() {
  return `<header class="hero"><div class="hello">Willkommen ☀️</div><div class="date">MyLife – dein KI-Lebens-Coach</div></header>
    <section class="card"><h2>🔑 Anmelden</h2>
      <p class="small muted" style="margin:0 0 12px">Gib deinen Zugangsschlüssel ein. Er steht auf deinem PC in <b>data/access-key.txt</b> (und wird beim Start des Servers angezeigt). Du musst das nur einmal pro Gerät machen.</p>
      <input type="text" id="login-key" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX">
      <button class="btn primary block" data-action="login">Anmelden</button>
    </section>`;
}
const offlineBanner = () => S.offline
  ? `<section class="card" style="border:2px solid var(--warn)"><h2>🔌 PC nicht erreichbar</h2>
      <p class="small muted" style="margin:0">Läuft dein PC mit MyLife und Tailscale Funnel? Ich versuch’s automatisch weiter.</p>
      <button class="btn block" data-action="retry">Nochmal versuchen</button></section>` : '';

function render() {
  const views = { heute: viewHeute, merken: viewMerken, schoko: viewSchoko, einstellungen: viewEinstellungen };
  const nav = document.querySelector('.tabs');
  if (S.needLogin) {
    $('#view').innerHTML = viewLogin();
    $('#fab').hidden = true;
    nav.hidden = true;
    return;
  }
  nav.hidden = false;
  $('#view').innerHTML = offlineBanner() + views[S.tab]();
  $('#fab').hidden = S.tab === 'merken' || S.tab === 'einstellungen';
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === S.tab));
  updateRing();
}

async function refresh(tab = S.tab) {
  try {
    if (tab === 'heute') S.today = await api('/today');
    if (tab === 'merken') S.items = await api('/items');
    if (tab === 'schoko') S.choc = await api('/choc');
    if (tab === 'einstellungen') S.settings = await api('/settings');
    if (tab === S.tab && !isTyping()) render();
    else if (tab === S.tab) pendingRender = true;
  } catch (e) {
    console.warn(e.message);
  }
}

let pendingRender = false;
const isTyping = () => { const a = document.activeElement; return a && $('#view').contains(a) && /TEXTAREA|INPUT/.test(a.tagName); };
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !isTyping()) { pendingRender = false; render(); } }, 50));

function go(tab) {
  S.tab = TABS.includes(tab) ? tab : 'heute';
  if (location.hash !== '#' + S.tab) history.replaceState(null, '', '#' + S.tab);
  render();
  refresh();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => go(location.hash.slice(1)));

// live updates from the PC
function connectEvents() {
  const es = new EventSource('/api/events');
  let t;
  es.onmessage = () => { clearTimeout(t); t = setTimeout(() => refresh(), 150); };
  es.onerror = () => {}; // EventSource reconnects by itself
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.needLogin) refresh(); });
// fallback polling – live events may be cut by proxies (e.g. Netlify)
setInterval(() => { if (!document.hidden && !S.needLogin && !isTyping()) refresh(); }, 20000);

// craving timer
let ringTimer;
function updateRing() {
  clearInterval(ringTimer);
  const a = S.tab === 'schoko' && S.choc?.active;
  if (!a) return;
  const tick = () => {
    const left = Math.max(0, CRAVE_MS - (Date.now() - a.created_at));
    const el = $('#ring-time');
    if (!el) return clearInterval(ringTimer);
    el.textContent = left ? `${Math.floor(left / 60000)}:${pad(Math.floor((left % 60000) / 1000))}` : '🎉';
    $('#ring').style.setProperty('--p', (100 * (CRAVE_MS - left)) / CRAVE_MS);
    if (!left) { $('.ring-label').textContent = 'geschafft?'; clearInterval(ringTimer); }
  };
  tick();
  ringTimer = setInterval(tick, 1000);
}

// ================= VOICE =================
let rec = null;
function stopMic() { if (rec) { rec.stop(); rec = null; } }
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Spracheingabe geht hier nicht – nutz das 🎙️ auf deiner Tastatur');
  if (rec) return stopMic();
  rec = new SR();
  rec.lang = 'de-DE';
  rec.interimResults = true;
  const base = S.form.capture.trim() ? S.form.capture.trim() + ' ' : '';
  rec.onresult = (ev) => {
    let txt = '';
    for (const r of ev.results) txt += r[0].transcript;
    S.form.capture = base + txt;
    document.querySelectorAll('[data-bind="capture"]').forEach((ta) => (ta.value = S.form.capture));
  };
  rec.onerror = (e) => { if (e.error === 'not-allowed') toast('Mikrofon nicht erlaubt'); };
  rec.onend = () => { rec = null; document.querySelectorAll('.mic').forEach((m) => m.classList.remove('on')); };
  rec.start();
  document.querySelectorAll('.mic').forEach((m) => m.classList.add('on'));
}

// ================= PUSH =================
function b64ToBytes(b64) {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function syncPush() {
  if (!S.push.supported) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  S.push.subscribed = !!sub && Notification.permission === 'granted';
  if (S.push.subscribed) await api('/push/subscribe', { method: 'POST', body: sub.toJSON() }).catch(() => {});
}
async function enablePush() {
  if (!S.push.supported) return toast('Push geht nur über die https://…ts.net-Adresse');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Benachrichtigungen wurden nicht erlaubt');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await api('/push/key');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  }
  await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  S.push.subscribed = true;
  toast('Erinnerungen sind an 🔔');
  refresh();
}

// ================= ACTIONS =================
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

const actions = {
  go: (d) => go(d.tab),
  retry: () => refresh(),
  login: async () => {
    const key = $('#login-key').value.trim();
    if (!key) return toast('Bitte Schlüssel eingeben');
    await api('/login', { method: 'POST', body: { key } });
    S.needLogin = false;
    toast('Willkommen! ☀️');
    syncPush().catch(() => {});
    go(S.tab);
  },
  logout: async () => {
    await api('/logout', { method: 'POST' });
    S.needLogin = true;
    render();
  },
  pick: (d) => { setPath(S.form, d.group, JSON.parse(d.value)); render(); },

  // capture
  openCapture: () => { openSheet({ type: 'capture' }); setTimeout(() => $('#sheet [data-bind="capture"]')?.focus(), 250); },
  mic: () => toggleMic(),
  sendCapture: async () => {
    stopMic();
    const text = S.form.capture.trim();
    if (!text) return toast('Sag oder schreib erst etwas 🙂');
    S.form.capture = '';
    if (S.sheet?.type === 'capture') closeSheet();
    document.activeElement?.blur();
    await api('/inbox', { method: 'POST', body: { text } });
    toast('Gemerkt ✨');
    refresh();
  },

  // items
  toggleItem: async (d, el) => {
    el.closest('.item')?.classList.toggle('done');
    await api(`/items/${d.id}/done`, { method: 'POST', body: { toggle: true } });
    refresh();
  },
  editItem: (d) => {
    const all = [...(S.items?.open || []), ...(S.items?.done || []), ...(S.today?.due || [])];
    const item = all.find((x) => String(x.id) === d.id);
    if (item) openSheet({ type: 'edit', item });
  },
  quickDue: (d) => {
    const inp = $('#e-due');
    if (d.clear) inp.value = '';
    else if (d.tomorrow) { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0); inp.value = toLocalInput(t); }
    else inp.value = toLocalInput(Date.now() + Number(d.min) * 60000);
  },
  saveItem: async () => {
    const v = $('#e-due').value;
    await api(`/items/${S.sheet.item.id}`, { method: 'PATCH', body: { title: $('#e-title').value.trim() || S.sheet.item.title, due_at: v ? new Date(v).getTime() : null } });
    closeSheet();
    toast('Gespeichert');
    refresh();
  },
  deleteItem: async () => {
    await api(`/items/${S.sheet.item.id}`, { method: 'DELETE' });
    closeSheet();
    toast('Gelöscht');
    refresh();
  },
  closeSheet: () => closeSheet(),
  closeSheetBackdrop: (d, el, e) => { if (e.target === el) closeSheet(); },

  // today
  submitMorning: async () => {
    const f = S.form.morning;
    await api('/checkin/morning', { method: 'POST', body: f });
    S.form.morning = { sleep: null, energy: null, note: '' };
    refresh();
  },
  planWithout: async () => { await api('/plan/regenerate', { method: 'POST' }); refresh(); },
  regenPlan: async () => { await api('/plan/regenerate', { method: 'POST' }); refresh(); },
  toggleMoment: async (d, el) => {
    const li = el.closest('.moment');
    li.classList.toggle('done');
    if (li.classList.contains('done') && navigator.vibrate) navigator.vibrate(30);
    S.today.plan = await api('/plan/toggle', { method: 'POST', body: { index: Number(d.i) } });
    render();
  },
  swapMoment: async (d) => { await api('/plan/swap', { method: 'POST', body: { index: Number(d.i) } }); refresh(); },
  submitEvening: async () => {
    const f = S.form.evening;
    if (f.mood == null) return toast('Wie war deine Stimmung? 🙂');
    await api('/checkin/evening', { method: 'POST', body: f });
    S.form.evening = { mood: null, choc: null, moved: null, note: '' };
    refresh();
  },

  // chocolate
  startCraving: async () => {
    if (navigator.vibrate) navigator.vibrate(40);
    await api('/cravings', { method: 'POST' });
    refresh();
  },
  setTrigger: async (d) => {
    const a = S.choc.active;
    a.trigger = a.trigger === d.value ? null : d.value;
    render();
    await api(`/cravings/${a.id}`, { method: 'PATCH', body: { trigger: a.trigger } });
  },
  resolveCraving: async (d) => {
    await api(`/cravings/${S.choc.active.id}`, { method: 'PATCH', body: { outcome: d.outcome } });
    toast(d.outcome === 'resisted' ? 'Stark! 💪 Genau so wird’s zur Gewohnheit.' : 'Alles gut. Genieß es bewusst – nächstes Mal wieder. 🤍');
    refresh();
  },
  logAte: async () => { await api('/choc/log', { method: 'POST' }); toast('Eingetragen. Ehrlichkeit ist der erste Schritt 🤍'); refresh(); },
  analyzeChoc: async () => { await api('/choc/analyze', { method: 'POST' }); refresh(); },

  // settings
  enablePush: () => enablePush().catch((e) => toast('Fehler: ' + e.message)),
  testPush: async () => {
    const r = await api('/push/test', { method: 'POST' });
    toast(r.sent ? 'Test gesendet – schau aufs Handy 📱' : 'Kein Gerät verbunden – erst aktivieren');
  },
  saveSettings: async () => {
    await api('/settings', {
      method: 'PUT',
      body: {
        name: $('#s-name').value.trim(), morning_time: $('#s-morning').value, evening_time: $('#s-evening').value,
        bedtime: $('#s-bed').value, winddown_min: $('#s-wind').value, profile: $('#s-profile').value,
      },
    });
    toast('Gespeichert ✅');
    refresh();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.dataset.action === 'closeSheetBackdrop' && e.target !== el) return;
  e.preventDefault();
  try { await fn(el.dataset, el, e); } catch (err) { console.error(err); toast('Ups: ' + err.message.slice(0, 80)); }
});
document.addEventListener('input', (e) => {
  const b = e.target.dataset?.bind;
  if (b) setPath(S.form, b, e.target.value);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.dataset?.bind === 'capture') { e.preventDefault(); actions.sendCapture(); }
  if (e.key === 'Enter' && e.target.id === 'login-key') { e.preventDefault(); actions.login().catch((err) => toast(err.message)); }
  if (e.key === 'Escape' && S.sheet) closeSheet();
});

// ================= BOOT =================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => { console.warn('SW', e); S.push.supported = false; });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'nav') { const h = new URL(e.data.url, location.href).hash.slice(1); go(h); }
  });
  syncPush().then(render).catch(() => {});
}
connectEvents();
go(location.hash.slice(1));
