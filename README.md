# BookHunt

A self-hosted web app that searches the Mobilism ebook forum by title and/or author, auto-crawls collection posts, triggers Premium downloads where available, and stores ePUBs in a private Cloudflare R2 bucket (or a local folder in dev). Accessible at `http://localhost:3000` locally or at `https://bookhunt.mooseflip.com` via Cloudflare Tunnel.

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
- **Premium downloads** — fetched via the Mobilism amember downloader, verified, and stored in R2 (see [Book storage](#book-storage-cloudflare-r2--local))
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
PORT=3000

# Book storage — local dev usually keeps books on disk:
STORAGE=local
DOWNLOAD_PATH=./downloads
# ...or point at the real bucket (see "Book storage" below):
# STORAGE=r2
# R2_ACCOUNT_ID=  R2_ACCESS_KEY_ID=  R2_SECRET_ACCESS_KEY=  R2_BUCKET=bookhunt-library

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

**1. Create your `.env`** (same as above, but with `STORAGE=r2` and the four
`R2_*` vars set — the container has no books volume, so `STORAGE=local` would
write books into its ephemeral filesystem)

**2. Make sure `history.json` exists**
```bash
touch history.json
```

**3. Start the container**
```bash
npm run docker:up        # build + up, stamping version/commit/build time
docker logs bookhunt-app-1
```

Expected output:
```
Storage: R2 bucket "bookhunt-library" — N object(s) indexed
BookHunt running at http://localhost:3000
Downloads will be staged in /tmp/bookhunt-staging and stored in r2://bookhunt-library/books/
```

**To stop:**
```bash
docker compose down
```

**To rebuild after a code change:**
```bash
npm run docker:up
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

Books have no volume: they live in Cloudflare R2 (see *Book storage* below).
The other gitignored state files (`recipients.json`, `recipient-groups.json`,
`booktags.json`, `covers-cache.json`, `watchlist.json`, `settings.json`,
`lists.json`) are single-file binds too — see `docker-compose.yml`.

> The container runs as `user: "1000:1000"` so these bind-mounted files stay
> owned by you, not root. If files ever end up root-owned (e.g. from an older
> setup), fix them without sudo via:
> `docker run --rm -v "$PWD/.browser-profile:/p" alpine chown -R 1000:1000 /p`

### Book storage (Cloudflare R2 / local)

**Production runs `STORAGE=r2`** (since 2026-10-02, issue #47): every book lives
only in the private Cloudflare R2 bucket `bookhunt-library`, under `books/`.
There is no local copy and no books volume. `STORAGE=local` (the code default)
keeps books as plain files in `DOWNLOAD_PATH` and is used for tests and local dev.

How r2 mode works:

- **Identity is unchanged.** History and tags still key on the logical
  `/downloads/<file>.epub` path; the storage layer maps it to the object key
  `books/<file>.epub`. Nothing in `history.json`/`booktags.json` is rewritten.
- **Downloads** are saved and unpacked (ZIP/RAR) in a per-attempt staging dir
  (`STORAGE_STAGING_DIR`, container-local `/tmp`), verified, and only the final
  file is uploaded. The staging dir is always removed, success or failure.
- **The Library** answers "is the file there?" from an in-memory index built from
  one bucket listing (refreshed every `STORAGE_INDEX_REFRESH_MS`), never a request
  per book. Send-to-Kindle fetches the bytes from R2 once per send.
- **Health:** the Status view shows `R2 (N objects)` or `R2 unreachable — …`;
  `/api/status` and `/healthz` carry a `storage` block (healthz stays 200 even if
  R2 is down — a restart can't fix a remote outage). The app refuses to start if
  `STORAGE=r2` and any `R2_*` var is missing.
- **Credentials:** a bucket-scoped R2 API token (Object Read & Write) in `.env`
  only — never committed, never logged.

**Backups:** R2 is the only copy. To take one, sync the bucket's `books/` prefix
to a host folder (e.g. `rclone sync r2:bookhunt-library/books ./books-backup`).

**Rollback to local:** copy `books/` back to a host folder, re-add it as a
`/downloads` bind mount in `docker-compose.yml`, set `STORAGE=local`, and
`npm run docker:up`. History is unchanged, so the Library resolves again once the
files are back. Don't flip to `local` without the bind mount — downloads would
land in the container's ephemeral filesystem and vanish on the next recreate.

**Migration script** (`scripts/migrate-to-r2.js`, how the cutover was done; `scripts/`
ships in the image since v1.30.0, but this one was run from the host): `node scripts/migrate-to-r2.js
--src <folder>` is a dry run that lists the bucket and prints the plan; add
`--apply` to upload. It's idempotent (present objects are skipped), verifies each
upload, and never deletes or modifies local files. Reuse it to re-seed the bucket
from a backup.

Tests always run with `STORAGE=local` (pinned in `npm test`) and talk only to an
in-memory fake S3 — never the real bucket.

### App data (local JSON + MongoDB Atlas mirror)

Everything that isn't a book (history/Library index, watchlist, recipients +
groups, book tags, radar state, settings) lives in the bind-mounted JSON files,
read and written through `src/datastore.js`. With `DATA_STORE=mongo` (the
docker-compose default) each write is also mirrored, in the background, to one
document per store in Atlas (`MONGODB_DB`, collection `stores`). That is the
offsite copy: losing this machine loses no data.

- **Startup** reconciles every store before serving: Atlas newer (or no local
  file, e.g. a rebuilt machine) → restored locally; local newer (an Atlas write
  failed before shutdown) or no Atlas copy yet → pushed up.
- **Outage**: the app keeps running on the local files and retries Atlas in the
  background; `/api/status` → `data` shows `connected`, `pending`, `lastError`.
  If Atlas is down **and** a local file is missing, it refuses to start rather
  than run empty and overwrite the good Atlas copy.
- **Disaster recovery**: restore the repo + `.env` (keep `.env` in a password
  manager — it is not in Atlas), `npm run docker:up`; the empty files are
  restored from Atlas at startup.
- `covers-cache.json`, `cover-images/` and `.browser-profile/` are rebuilt on
  demand and are not mirrored.

Tests pin `DATA_STORE=file` and point every store at a temp dir
(`test/setup-env.js`); `test/datastore-mongo.test.js` runs against a real,
throwaway MongoDB only when `MONGODB_TEST_URI` is set.

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

### Cloudflare API token (for API-driven changes)

The tunnel cert at `~/.cloudflared/cert.pem` is scoped to **Tunnel + DNS only** — it cannot manage Cloudflare Access apps (verified: the Access API rejects it). For API-driven work on Access, DNS, or tunnels, a standing scoped token lives outside the repo at:

```
~/.config/cloudflare/mooseflip.token      # mode 600, gitignored by virtue of living outside any repo
```

Scopes granted on the **mooseflip** account (`13887f102c0b8baa1f9b10450c4550f0`, zone `e0b2d5fd3686b6bf2ad68341dfbc3632`): **Cloudflare Tunnel → Edit**, **DNS → Edit**, **Access: Apps and Policies → Edit**. Use it as `Authorization: Bearer $(cat ~/.config/cloudflare/mooseflip.token)`. Revoke/rotate at dash.cloudflare.com → My Profile → API Tokens.

> To (re)create the file without the token touching a shell history or a chat transcript, run this in a **real terminal** (not via a chat `!` prefix):
> ```bash
> mkdir -p ~/.config/cloudflare && umask 077
> read -rs CFT && printf '%s' "$CFT" > ~/.config/cloudflare/mooseflip.token; unset CFT
> ```

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

### Reader portal — letting `/reader/*` past Access

> **Already configured** (2026-07-04): a path-scoped app `Bookhunt Reader (public bypass)` for `bookhunt.mooseflip.com/reader` with a Bypass/Everyone policy is live (Access app id `2ffcea40-e197-456d-8d23-71c43b893fc6`). The steps below are the reference for re-creating it if it's ever removed.

The reader portal (magic-link book picker, issue #34) is for people who are **not** in your Access policy — Darla, April, anyone you invite. They can't pass the Cloudflare login, so `/reader/*` must be exempted at the edge:

1. **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**
2. **Application domain**: `bookhunt.mooseflip.com` with **Path** = `reader` (this makes it a *path-scoped* app that takes precedence over the site-wide one)
3. Add a single policy: **Action: Bypass**, **Include: Everyone**
4. Save.

That's the only manual step. The origin still guards `/reader/*` itself: `src/security.js` skips the CF JWT check for that path, and `src/reader.js` requires a valid per-recipient token instead (constant-time lookup, rate-limited, 404 on bad tokens). A reader token's entire authority is *view recent covers + send to that recipient's own Kindle* — no downloads, no settings, no other readers. If a link leaks, hit **♻** next to the recipient (in Manage recipients) to rotate their token; the old link dies immediately.

Set `PUBLIC_BASE_URL` in `.env` (defaults to `https://bookhunt.mooseflip.com`) so the links in reader emails point at the right origin.

### Reader portal (`/reader`) — the one deliberate hole in the wall

The reader portal (issue #34) lets invited readers open a passwordless magic link and send books to their own Kindle. Readers aren't in the Access policy, so `/reader/*` must **bypass** Cloudflare Access at the edge — one manual step:

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**
2. **Application domain**: `bookhunt.moo

1. **Pass 1 — title search** (up to 5 pages of results), scoped to the eBooks forum and its subforums (`fid[]=106&sc=1`). When both title and author are given, both go into the query so it lands directly on the match. Filtered to ePUB, fuzzy-matched, deduplicated by URL.
2. **Collection detection.** Posts with `Collection`, `Complete Works`, `&`, `Series`, or `Omnibus` in the title are crawled (max 3) and their content scanned line-by-line for a title match.
3. **Author-sets pass.** When both title and author are given and the passes above found nothing, a second title-only search runs for `{author} epub` (the `epub` keyword drops the author's audiobook posts, so old set threads stay within the page cap). Each set post it finds (e.g. *"7 Books by Sally Hepworth"*, *"4 Novels by …"*, *"… Series (.ePUB)+"*, trilogies, box sets, `#1-3`) is opened (up to 8) and scanned for the requested title, so a book only available inside a bundle, including an old set thread later updated with it, still surfaces. Results merge with Pass 1 and are deduped by URL. Matching folds spelling variants (accents, `&`/and, apostrophes, initials, number words, Mr/Dr/St) and ignores the co-author "and".
4. **Author fallback.** Last resort, only if nothing turned up at all. Searches the author **title-only**, and for each hit requires the post's actual author (parsed from "… by *author*") to match before scanning its content for the title — so a book whose blurb merely name-drops the author (e.g. "for fans of *Colleen Hoover*") can't masquerade as a match.
5. **Zero results.** Shows a "Not found" message with manual search links for Mobilism.

> Title and author tokens are matched at **word starts**, not bare substrings — short tokens like `it`/`us` in *It Ends with Us* no longer match inside `with`/`trust`, while stems like `demon` → `demons` still do.

### Book covers

Every cover in the app (Library, search results, watchlist, the reader shelf, and the cover in emails) comes from one stored-image pipeline, `src/coverstore.js`. A book's cover is resolved once, saved to `cover-images/` (bind-mounted), and served from disk after that. Browsers never load covers directly from the catalogs. The chain:

1. The cover stored with the download (the search hit's own image).
2. The cover embedded in the EPUB itself (read from storage once).
3. Catalogs (`src/covers.js`): Open Library, then Apple Books (iTunes Search), then Google Books (loose query, then a field-specific one), then Open Library general search. Transient failures (429, 5xx, timeouts) are retried with backoff. A miss caused by a failure is cached for 1 hour; a clean miss for 7 days.
4. A generated SVG jacket with the title and author, so a cover is never blank. It's re-tried against real sources after 24 hours.

Endpoints: `/cover-image/book/:id` (Library), `/cover-image/lookup?title=&author=` (books not in the Library), and `/reader/cover?t=&id=` (shelf; token-gated, with its own rate limit). `cover-images/` is a re-derivable cache, so deleting it only costs re-fetches. Stored covers are normalized with `sharp`: anything over 900×1350 or 350 KB is resized and saved as a JPEG, and covers saved before this are shrunk the next time they're served. Emails use the same stored image; a generated jacket is converted to PNG for email (`getEmailCoverImage`), because email clients don't render SVG.

### Reader shelf: book details + feature announcements

Tapping a book on the reader shelf opens a details modal (`<dialog>` in `public/reader.html`) with a larger cover and the catalog description, served by `GET /reader/api/book?t=&id=`. Only sendable books resolve; anything else returns 404. Descriptions come from the disk-cached `covers.resolveMeta`. New shelf features announce themselves once per device with `spotlightFeature()` in `public/reader.js`.

To email readers about a feature, run `docker compose exec app node scripts/announce-book-details.js`. It must run **inside the container**: it writes `recipients.json`, and an atomic rename from the host would swap the file's inode out from under the single-file bind mount. It is a dry run by default: it lists recipients and writes an HTML preview. `--only <id|email> --send` sends a test to one recipient, and `--send` emails everyone. Readers who unsubscribed are skipped. Each recipient is stamped `readerAnnouncements[<id>]`, so re-running never emails anyone twice.

### Downloads

- **Premium** (`img.MobilismDownloaderIcon` found in post): each associated download link is fetched through the amember downloader into a staging dir, verified, and stored (R2 in production, `DOWNLOAD_PATH` with `STORAGE=local`). Credentials are entered in the UI once per session and never written to disk (or optionally set via `MOBILISM_PREMIUM_USER`/`MOBILISM_PREMIUM_PASS` in `.env`). If a mirror serves the book wrapped in a **ZIP or RAR archive**, it's unpacked automatically: the inner `.epub` is extracted (the matching book is chosen when a bundle holds several), the archive is deleted, and verification + send-to-reader run on the real `.epub`.
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
| `DOWNLOAD_PATH` | No | `./downloads` (`/downloads` under docker-compose) | `STORAGE=local` only: folder where ePUBs are saved (unused in r2 mode) |
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
| `STORAGE` | No | `local` (`r2` under docker-compose) | Where books live: `local` (files in `DOWNLOAD_PATH`) or `r2` (Cloudflare R2 bucket) — see [Book storage](#book-storage-cloudflare-r2--local) |
| `R2_ACCOUNT_ID` | When `STORAGE=r2` | — | Cloudflare account id (R2 S3 endpoint) |
| `R2_ACCESS_KEY_ID` | When `STORAGE=r2` | — | Bucket-scoped R2 API token (Object Read & Write) |
| `R2_SECRET_ACCESS_KEY` | When `STORAGE=r2` | — | Its secret — never logged or committed |
| `R2_BUCKET` | When `STORAGE=r2` | — | Bucket name (`bookhunt-library`) |
| `STORAGE_STAGING_DIR` | No | `<os tmp>/bookhunt-staging` | r2 only: scratch dir for in-flight downloads/extraction |
| `STORAGE_INDEX_REFRESH_MS` | No | `600000` | r2 only: how often the bucket listing (key index) is refreshed |
| `STORAGE_STARTUP_TIMEOUT_MS` | No | `15000` | r2 only: max wait for the first bucket listing before serving anyway |
| `DATA_STORE` | No | `file` (`mongo` under docker-compose) | `mongo` mirrors the JSON stores to Atlas — see [App data](#app-data-local-json--mongodb-atlas-mirror) |
| `MONGODB_URI` | When `DATA_STORE=mongo` | — | Atlas connection string for the dedicated bookhunt user — never logged |
| `MONGODB_DB` | When `DATA_STORE=mongo` | — | Database name (`bookhunt`) |

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
  storage.js      Book storage: local disk or Cloudflare R2 (STORAGE)
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
scripts/
  migrate-to-r2.js  Copy a local books folder into R2 (dry run by default)
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

**Status shows `R2 unreachable` / Library marks every book missing**
The bucket listing failed (network, or the R2 token was revoked/expired). Check
`docker logs bookhunt-app-1` for the `Storage:` line, confirm the `R2_*` values in
`.env`, then `npm run docker:up`. The index retries every
`STORAGE_INDEX_REFRESH_MS`, so a transient outage clears on its own.

**Premium download: "account expired"**
Your premium subscription has lapsed. The app detects this and reports it immediately rather than hanging. Renew on Mobilism and retry.

**Only one instance can run at a time**
The browser profile directory can only be used by one Chromium process. If you start a second instance while one is already running, the second one will fail at browser launch.
