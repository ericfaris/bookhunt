# BookHunt

A self-hosted web app that searches the Mobilism ebook forum by title and/or author, auto-crawls collection posts, triggers Premium downloads where available, and saves ePUBs to disk. Accessible at `http://localhost:3000` locally or at `https://bookhunt.mooseflip.com` via Cloudflare Tunnel.

> For personal use against an account you own. Drives a real Chromium browser with your logged-in session and inserts polite 2–5s delays between requests.

---

## Features

- **ePUB-only** — all other formats filtered out
- **Archive unwrapping** — releases posted as a `.zip`/`.rar` are extracted; the inner `.epub` is pulled out and used for verification + sending (ZIP handled natively, RAR via `node-unrar-js`)
- **Per-book selection** — in "Books by Author" posts, the target book's own section (its name or an abbreviation like `W:` for *Whistler*) is preferred over the first link, which is usually an all-books archive
- **Fuzzy matching** — `1984` matches `1984: Illustrated Edition`; tokens match at word starts (so short titles like *It Ends with Us* don't false-positive inside unrelated words)
- **Collection crawling** — auto-scans up to 3 bundle/series/omnibus posts per search
- **Author fallback** — title-only author search as a last resort, gated on the post's actual author so blurb name-drops don't leak in
- **Spell-correction** — fixes fuzzy title/author before searching (Google Books → Open Library)
- **Amazon prefill** — a smart **Paste** button scrapes an Amazon link, plus a [browser extension](extension/README.md) that searches straight from any Amazon book page
- **Premium downloads** — saved directly to disk via the Mobilism amember downloader
- **Standard links** — per-host download buttons when no Premium icon is present
- **Search history** — stored in `history.json`, re-runnable with one click
- **Dark mode** — via `prefers-color-scheme`

---

## Prerequisites

- Node.js 20+
- Docker + Docker Compose (for containerized deployment)
- A Mobilism forum account

---

## Running locally (no Docker)

**1. Install dependencies and the Playwright browser**
```bash
npm install
npm run install-browser
```

**2. Create your `.env`**
```bash
cp .env.example .env
```

Fill in:
```
MOBILISM_USER=your_forum_username
MOBILISM_PASS=your_forum_password
DOWNLOAD_PATH=/mnt/c/epubs        # WSL path to C:\epubs
PORT=3000

# Optional: premium downloader login (loaded at startup; UI form overrides)
MOBILISM_PREMIUM_USER=
MOBILISM_PREMIUM_PASS=
```

> **Note:** The premium downloader password is separate from your forum password — Mobilism sends it by PM.

**3. Start**
```bash
DISPLAY=:0 npm start
```

Open [http://localhost:3000](http://localhost:3000).

A Chromium window will appear (required — Mobilism uses Cloudflare bot protection that blocks headless browsers). The session is saved to `.browser-profile/` so you only log in once.

---

## Running with Docker

The container runs Chromium **headed under a virtual display (Xvfb)** as your
user (`uid:gid 1000`). Mobilism's Cloudflare blocks headless browsers, so the
browser runs headed in-container and is logged in **remotely via `/warm`** (a
noVNC view of the live browser) — no host-side warm step is needed.

**1. Create your `.env`** (same as above)

**2. Make sure `history.json` exists**
```bash
touch history.json
```

**3. Start the container**
```bash
docker compose up -d
docker logs bookhunt-app-1
```

Expected output:
```
BookHunt running at http://localhost:3000
Downloads will be saved to: /downloads
```

**To stop:**
```bash
docker compose down
```

**To rebuild after a code change:**
```bash
docker compose up -d --build
```

### Re-warming (when the session expires)

The saved session lasts a long time, but eventually Mobilism's Cloudflare
clearance or the forum login expires. When it does, the app shows a red
**"Mobilism session expired — Re-warm"** banner (and searches return a 409
`needWarm`). To refresh — no host steps, no restart:

1. Click **Re-warm ↗** in the banner (or open `https://bookhunt.mooseflip.com/warm`).
2. A noVNC view of the live in-container browser appears. Clear any Cloudflare
   challenge / log into the forum there.
3. Switch back to the app — the banner clears and search works again.

Keep the container **always running**; a cold Chromium start is the most reliable
way to trigger a fresh Cloudflare challenge. `entrypoint.sh` self-heals stale X
and Chromium profile locks on boot, so `docker compose up -d` just works.

### Docker volumes

| Host path | Container path | Purpose |
|---|---|---|
| `./.browser-profile` | `/app/.browser-profile` | Playwright persistent session (Cloudflare clearance + forum login) |
| `./history.json` | `/app/history.json` | Search + download log |
| `/mnt/c/epubs` | `/downloads` | Downloaded ePUBs |

> The container runs as `user: "1000:1000"` so these bind-mounted files stay
> owned by you, not root. If files ever end up root-owned (e.g. from an older
> setup), fix them without sudo via:
> `docker run --rm -v "$PWD/.browser-profile:/p" alpine chown -R 1000:1000 /p`

---

## Cloudflare Tunnel (remote access via bookhunt.mooseflip.com)

The app is exposed at `https://bookhunt.mooseflip.com` through the existing `youtube-rss` Cloudflare Tunnel. No separate tunnel is needed — it's an additional ingress rule on the same tunnel.

### Current config (`/etc/cloudflared/config.yml`)

```yaml
tunnel: 83441a36-f288-40e3-ab39-9393b284ccc5
credentials-file: /etc/cloudflared/83441a36-f288-40e3-ab39-9393b284ccc5.json

ingress:
  - hostname: rss.mooseflip.com
    service: http://localhost:8000
  - hostname: bookhunt.mooseflip.com
    service: http://localhost:3000
  - service: http_status:404
```

### If you need to re-add the DNS record
```bash
cloudflared tunnel route dns youtube-rss bookhunt.mooseflip.com
sudo systemctl restart cloudflared
```

### Securing with Cloudflare Access

The app has no user accounts of its own — Cloudflare Access is the front door. To restrict access to your email only, add a Cloudflare Access application:

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Zero Trust** → **Access** → **Applications**
2. Click **Add an application** → **Self-hosted**
3. Set **Application domain** to `bookhunt.mooseflip.com`
4. Create a policy: **Allow** where **Email** = `ericfaris@gmail.com`
5. Save

Cloudflare will send a one-time code to your email on each new session.

### Origin-side hardening (defense in depth)

Cloudflare Access is the front gate, but the origin no longer trusts it blindly. The app adds these layers so it stays locked down even if the tunnel is reached directly or the Access policy is ever loosened (see `src/security.js`):

- **Access JWT verification** — every request (and the `/warm` WebSocket) must carry a valid `Cf-Access-Jwt-Assertion` signed by your Cloudflare team, validated against the team's public keys with the expected audience (AUD). Without it the request gets a `401`. The app **fails closed**. Enable by setting `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (find the AUD under the Access app's **Overview**); optionally pin `CF_ACCESS_ALLOWED_EMAILS`. If unset, verification is skipped and a warning is logged.
- **Security headers** — CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- **Rate limiting** — per-IP cap on `/api/*` (keyed on `CF-Connecting-IP`).
- **Input hardening** — 64 KB JSON body cap, length-bounded search inputs, anchored Amazon-host matching (no `amzn.evil.com` lookalikes), `/api/download` restricted to `mobilism.org` URLs, validated recipient emails.
- **Container** — runs as non-root `uid 1000`, `no-new-privileges`, host port bound to `127.0.0.1` only.

> The single most important setting is `CF_ACCESS_AUD` + `CF_ACCESS_TEAM_DOMAIN`. Set them in `.env` so the origin verifies Cloudflare's signature itself — Access on its own can be bypassed if someone finds the raw tunnel hostname.

---

## How search works

1. **Pass 1 — title search** (up to 5 pages of results), scoped to the eBooks forum and its subforums (`fid[]=106&sc=1`). When both title and author are given, both go into the query so it lands directly on the match. Filtered to ePUB, fuzzy-matched, deduplicated by URL.
2. **Collection detection.** Posts with `Collection`, `Complete Works`, `&`, `Series`, or `Omnibus` in the title are crawled (max 3) and their content scanned line-by-line for a title match.
3. **"Books by {author}" pass.** When both title and author are given, a second search runs for `books by {author}` (titleonly, eBooks forum). Each resulting set/collection post (e.g. *"7 Books by Sally Hepworth"*) is opened and scanned for the requested title — so a book only available inside a bundle still surfaces. Results merge with Pass 1 and are deduped by URL.
4. **Author fallback.** Last resort, only if nothing turned up at all. Searches the author **title-only**, and for each hit requires the post's actual author (parsed from "… by *author*") to match before scanning its content for the title — so a book whose blurb merely name-drops the author (e.g. "for fans of *Colleen Hoover*") can't masquerade as a match.
5. **Zero results.** Shows a "Not found" message with manual search links for Mobilism.

> Title and author tokens are matched at **word starts**, not bare substrings — short tokens like `it`/`us` in *It Ends with Us* no longer match inside `with`/`trust`, while stems like `demon` → `demons` still do.

### Downloads

- **Premium** (`img.MobilismDownloaderIcon` found in post): each associated download link is fetched through the amember downloader and saved to `DOWNLOAD_PATH`. Credentials are entered in the UI once per session and never written to disk (or optionally set via `MOBILISM_PREMIUM_USER`/`MOBILISM_PREMIUM_PASS` in `.env`). If a mirror serves the book wrapped in a **ZIP or RAR archive**, it's unpacked automatically: the inner `.epub` is extracted (the matching book is chosen when a bundle holds several), the archive is deleted, and verification + send-to-reader run on the real `.epub`.
- **Standard** (no Premium icon): every `a.postlink` is shown as a button labeled by file host and opens in a new tab.

---

## Prefilling a search from Amazon

Two ways to jump from an Amazon book page straight into a search:

- **Paste button** (in the app) — copy an Amazon link (or `Title — Author` text) and click **Paste**. Amazon links are scraped server-side via `/api/amazon`; plain text is parsed locally with no network call.
- **Browser extension** (`extension/`, Chrome/Edge, Manifest V3) — adds a **"🔍 Search on BookHunt"** button, a right-click entry, and a toolbar action to Amazon book pages. It scrapes the title/author (same cleaning rules as `src/amazon.js`) and opens the search prefilled. See [`extension/README.md`](extension/README.md) for install (load-unpacked) and config.

Both rely on **deep-link query params** the search page reads on load (`public/app.js` → `prefillFromQuery`, invoked last so module-level bindings are initialized before it runs):

| Param | Effect |
|---|---|
| `?title=…&author=…` | Fill the fields and auto-run the search (no network call) |
| `?amazon=<url>` | Scrape the product page server-side via `/api/amazon`, then search |
| `&go=0` | Fill the fields only; skip the auto-search |

The params are stripped from the URL afterward so a refresh doesn't re-fire.

---

## Notifications & Send-to-Kindle

After a **premium** download that passes ePUB **verification** (ZIP magic + size; standard links never touch the server, so they can't be sent), each file shows a **📧 Send to readers** button. Clicking it opens a modal where you pick recipients and send.

For each selected recipient the app can:
1. **Notify** them — an email to their normal inbox with the cover image and book details (this is the message a person actually reads).
2. **Push to Kindle** — if the recipient has a `@kindle.com` address set, the `.epub` is emailed there as an attachment; Amazon's Send-to-Kindle delivers it to their device.

Both use Gmail SMTP, sending **from `ericfaris@gmail.com`** (set via `SMTP_FROM`).

### Setup
1. Create a **Gmail App Password** for the account (requires 2FA) and put it in `SMTP_PASS` in `.env`.
2. For Kindle push: in **each recipient's** Amazon account → *Manage Your Content & Devices → Preferences → Personal Document Settings* — note their `@kindle.com` address and add `ericfaris@gmail.com` to the **Approved Personal Document E-mail List** (Amazon rejects un-approved senders).
3. Manage recipients in the Send modal ("Manage recipients"): `{ name, email, kindleEmail?, phone?, carrier? }`, stored in the gitignored `recipients.json`.

### Pluggable channels
Notification channels live in `src/notify/` and share one contract (`isConfigured`, `supports`, `send`). **Email** is active. **SMS/MMS via Twilio** is scaffolded in `src/notify/twilio.js` but disabled — enable it later by `npm install twilio`, setting `TWILIO_*` in `.env`, and filling in the (already-commented) `send()` body. The registry picks it up automatically; no caller changes. (Note: free carrier email-to-SMS gateways were not used — US carriers are decommissioning them.)

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MOBILISM_USER` | Yes | — | Mobilism forum username |
| `MOBILISM_PASS` | Yes | — | Mobilism forum password |
| `MOBILISM_PREMIUM_USER` | No | — | Premium downloader username |
| `MOBILISM_PREMIUM_PASS` | No | — | Premium downloader password |
| `DOWNLOAD_PATH` | No | `C:\epubs` | Where downloaded ePUBs are saved |
| `PORT` | No | `3000` | HTTP port |
| `HEADLESS` | No | `false` | Set `true` to run Chromium headless (only safe when the browser profile is warm and Cloudflare clearance is cached) |
| `PROFILE_DIR` | No | `.browser-profile/` | Path to the Playwright persistent browser profile |
| `EBOOKS_FID` | No | `106` | Mobilism eBooks forum id that searches are scoped to |
| `MOBILISM_BASE` | No | `https://forum.mobilism.org` | Forum base URL |
| `SMTP_HOST` | No | `smtp.gmail.com` | SMTP host for notifications + Kindle push |
| `SMTP_PORT` | No | `587` | SMTP port (587 STARTTLS / 465 TLS) |
| `SMTP_USER` | For email | — | Gmail address (`ericfaris@gmail.com`) |
| `SMTP_PASS` | For email | — | Gmail **App Password** (needs 2FA) |
| `SMTP_FROM` | No | `SMTP_USER` | From header; must be on recipients' Amazon approved-sender list |
| `TWILIO_ACCOUNT_SID` | No | — | Reserved for the future SMS/MMS channel |
| `TWILIO_AUTH_TOKEN` | No | — | Reserved for the future SMS/MMS channel |
| `TWILIO_FROM` | No | — | Reserved — Twilio sending number |

---

## Project layout

```
src/
  server.js       Express app + API routes
  searcher.js     Playwright session, search + crawl logic
  correct.js      Spell-correction of title/author before search
  amazon.js       Scrape title/author from an Amazon product page (Paste + prefill)
  downloader.js   Premium + standard download logic (+ ePUB verification, archive unwrap)
  archive.js      Detect ZIP/RAR and extract the inner ePUB(s)
  epub.js         Zero-dep ePUB (ZIP) metadata reader
  history.js      Read/write history.json
  recipients.js   CRUD over recipients.json
  smtp.js         Shared Gmail SMTP transport
  kindle.js       Send-to-Kindle push (.epub → @kindle.com)
  notify/
    index.js      Channel registry / fan-out
    email.js      Email notification channel (active)
    twilio.js     SMS/MMS channel (scaffolded, disabled)
public/
  index.html      Search UI + send modal
  style.css       Dark mode + layout
  app.js          Fetch calls + result rendering + send/recipients + deep-link prefill
extension/        Chrome/Edge extension: search from Amazon book pages
  manifest.json   Manifest V3
  background.js   Context menu + toolbar action
  content.js      Scrapes title/author, opens the prefilled search
entrypoint.sh     Xvfb + noVNC + app startup
Dockerfile
docker-compose.yml
.env.example
history.json      Search + download log (created on first run)
recipients.json   Notification recipients (gitignored)
.browser-profile/ Playwright persistent session (created on first run)
```

---

## Troubleshooting

**Browser shows a green/black screen**
Chromium's GPU compositing is broken under WSLg. The `--disable-gpu` flags in `searcher.js` fix this. If it recurs, check that the flags are present.

**"Could not log in to Mobilism" / re-warm banner appears**
The Cloudflare clearance or forum login expired. Open `/warm`, clear the challenge / log in via the live noVNC browser view, then return to the app. The session is saved to `.browser-profile/` for future runs.

**localhost:3000 shows the wrong app (green page / "Reel Quest")**
A stale service worker from a previous project on port 3000 is intercepting requests. Open DevTools → Application → Service Workers → Unregister, or clear site data for `localhost`.

**Premium download: "account expired"**
Your premium subscription has lapsed. The app detects this and reports it immediately rather than hanging. Renew on Mobilism and retry.

**Only one instance can run at a time**
The browser profile directory can only be used by one Chromium process. If you start a second instance while one is already running, the second one will fail at browser launch.
