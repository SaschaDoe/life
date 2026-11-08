# MyLife ☀️

Dein KI-Lebens-Coach. Läuft auf deinem PC, du nutzt ihn als App auf dem Android-Handy.
Das „Gehirn“ ist Claude Code, das im Hintergrund auf dem PC arbeitet.

## Was kann Phase 1?

| Bereich | Funktion |
|---|---|
| ☀️ **Heute** | Morgen-Check-in (Schlaf + Energie) → die KI plant **3 kleine Momente** für deinen Tag (↻ = anderer Vorschlag). Abends 1-Minuten-Abschluss mit persönlicher Antwort. |
| 📝 **Merken** | Sprechen oder tippen („Waschmaschine läuft“, „Elternabend Do 19 Uhr“) → die KI macht daraus Erinnerungen mit sinnvoller Uhrzeit. Push mit **✅ Erledigt** / **⏰ 15 Min**. Noch offen nach 30 Min → eine zweite Erinnerung. |
| 🍫 **Schoko** | Notfall-Button mit 10-Minuten-Timer und KI-Coach. Auslöser erfassen, Wochenübersicht, schokofreie Tage in Folge, Uhrzeit-Muster, KI-Musteranalyse. |
| 🔔 **Rhythmus** | Push-Nachrichten für Morgen-Check-in, Abend-Check-in und „Zeit fürs Bett“ (Zeiten unter ⚙️ Mehr). |
| 🧠 **Über mich** | `brain/profile.md` (auch unter ⚙️ Mehr editierbar). Das liest die KI bei jedem Vorschlag. Die Datei bleibt privat auf dem PC (nicht in Git), Vorlage: `brain/profile.example.md`. |

## Starten

```
npm start          # oder Doppelklick auf start.cmd
```
Dann am PC öffnen: http://localhost:3737

**Automatisch beim Hochfahren:** einmal `powershell -ExecutionPolicy Bypass -File install-autostart.ps1` ausführen.

## 🔑 Zugangsschlüssel

Beim ersten Start legt der Server einen Schlüssel an: **`data/access-key.txt`** (er wird auch beim Start angezeigt).
Den gibst du einmal pro Gerät ein, danach bleibst du ein Jahr angemeldet. Neuer Schlüssel: Datei löschen und Server neu starten.

## Aufs Handy bringen

Push-Nachrichten brauchen eine https-Adresse. Es gibt zwei Wege:

### Weg A: Netlify (Oberfläche) + Tailscale Funnel (PC)

```
Handy ──https──> Netlify (Oberfläche, /api/* wird weitergeleitet) ──> Tailscale Funnel ──> dein PC
```

1. **PC:** Tailscale installieren (`winget install tailscale.tailscale`) und anmelden.
2. In der Tailscale-Admin-Konsole (login.tailscale.com/admin/dns) **MagicDNS** und **HTTPS Certificates** aktivieren.
3. **PC, Terminal:** `tailscale funnel --bg 3737`. Damit bekommst du eine öffentliche Adresse wie `https://dein-pc.tail1234.ts.net`.
   (Die API ist durch den Zugangsschlüssel geschützt.)
4. **Netlify:** „Add new site → Import from GitHub“ → dieses Repo wählen. Die Build-Einstellungen kommen automatisch aus `netlify.toml`.
5. **Netlify → Site configuration → Environment variables:** `MYLIFE_API_URL` = deine Adresse aus Schritt 3 → **Deploys → Trigger deploy**.
6. **Handy:** die Netlify-Adresse in Chrome öffnen → Schlüssel eingeben → ⋮ → **„Zum Startbildschirm hinzufügen“** → **„Erinnerungen einschalten“**.

### Weg B: nur Tailscale (privat, ohne Internet-Zugang)

Tailscale auch aufs Handy installieren, am PC `tailscale serve --bg 3737` statt `funnel` ausführen und die `…ts.net`-Adresse auf dem Handy öffnen. Dann ist die App nur für deine eigenen Geräte sichtbar.

## Technik

- `server/`: Node.js + Express, SQLite (`data/mylife.db`), Web-Push, Zeitplaner (alle 20 s)
- `server/ai.js`: ruft `claude -p --json-schema …` headless auf (schnell: Sonnet, Planung: Opus)
- `public/`: PWA ohne Build-Schritt (Vanilla JS), Service Worker für Push und Offline
- Alle Daten bleiben lokal in `data/`. Der Server lauscht nur auf `127.0.0.1`, von außen geht es nur über Tailscale.
- `netlify.toml` + `scripts/netlify-build.js`: Netlify hostet nur `public/` und leitet `/api/*` an `MYLIFE_API_URL` weiter.
- `server/auth.js`: Zugangsschlüssel → signiertes HttpOnly-Cookie, alle `/api`-Routen sind geschützt.

## Ideen für Phase 2+

Wochenrückblick am Sonntag · Google-Kalender (Momente in freie Lücken legen) · Kunst-Galerie mit Fotos · Fokus-Blöcke für die Arbeit · Sport-Fortschritt · KI lernt automatisch, was bei dir funktioniert (schreibt selbst in `profile.md`) · Android-Teilen-Menü → „An MyLife senden“
