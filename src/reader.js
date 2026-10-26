'use strict';

// Reader portal (issue #34): passwordless, invite-only magic links that let a
// recipient browse recently shelved books and push the ones they want to their
// OWN Kindle — taking the operator out of the send loop.
//
// Identity is a per-recipient 32-byte token carried in the link
// (/reader?t=...). The token's entire authority is: view recent titles/covers,
// send to that recipient's stored Kindle address, and unsubscribe themselves —
// no downloads, no settings, no other readers. A leaked link is low-stakes and
// revocable (rotate = new token, old link dies).
//
// /reader/* bypasses Cloudflare Access at the edge (path-scoped bypass app —
// manual dashboard step, see README) and is instead guarded here: token
// lookup is constant-time over sha256 digests, bad tokens 404 (no oracle),
// and the routes ride a tight rate limit in server.js.

const crypto = require('crypto');

const recipients = require('./recipients');
const history = require('./history');
const library = require('./library');
const booktags = require('./booktags');
const covers = require('./covers');
const coverstore = require('./coverstore');
const kindle = require('./kindle');
const smtp = require('./smtp');
const watchlist = require('./watchlist');
const storage = require('./storage');
const { normalize, similarity } = require('./correct');

// Public origin for links in reader emails (the app itself never needs this —
// only mail does, since a reader's email client can't use relative URLs).
const {
  BASE_URL, readerLink, buildInviteEmail, buildNewBooksEmail, buildBookDetailsAnnouncement, BOOK_DETAILS_ANNOUNCEMENT, teaser,
} = require('./reader-emails');

// How far back the "new books" EMAIL digest looks (notifyNewBooks below). The
// shelf page itself shows the reader's whole library (paginated — see
// booksForReaderPage); this window only bounds what triggers an email.
const RECENT_DAYS = Number(process.env.READER_RECENT_DAYS) || 30;

// Shelf page size for lazy-loaded pagination — big enough to fill a screen or
// two without the reader scrolling much, small enough that a page load and
// each subsequent lazy fetch stay snappy.
const PAGE_SIZE = Number(process.env.READER_PAGE_SIZE) || 24;

// At most one "new books" email per reader per this window, however often the
// notifier is invoked — the notifier itself is fired opportunistically.
const NOTIFY_MIN_GAP_MS = Number(process.env.READER_NOTIFY_GAP_MS) || 20 * 3600 * 1000;

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * PURE: the per-reader web app manifest. The token is baked into start_url so
 * an installed home-screen icon (Android/Chrome, which uses the manifest)
 * launches straight to THIS reader's shelf. Icons + manifest live under
 * /reader/* so they clear Cloudflare Access like the rest of the portal. iOS
 * doesn't use start_url — it captures the current URL on "Add to Home Screen"
 * — so the token rides along there for free.
 */
function buildManifest(token) {
  const q = token ? `?t=${encodeURIComponent(token)}` : '';
  return {
    name: 'BookHunt',
    short_name: 'BookHunt',
    description: 'Your BookHunt Library — send books to your Kindle.',
    start_url: `/reader${q}`,
    scope: '/reader',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#f6f1e7',
    theme_color: '#1c2a56',
    icons: [
      { src: '/reader/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/reader/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/reader/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/** Ensure a recipient has a reader token (lazily minted, persisted). */
function ensureToken(id) {
  let found = null;
  recipients.mutate((list) => {
    const r = list.find((x) => x.id === id);
    if (!r) return false;
    found = r;
    if (r.readerToken) return false; // already has one — don't rewrite the file
    r.readerToken = newToken();
    if (r.readerEnabled === undefined) r.readerEnabled = true;
  });
  return found;
}

/** Rotate a recipient's token — the old magic link stops working immediately. */
function rotateToken(id) {
  let found = null;
  recipients.mutate((list) => {
    const r = list.find((x) => x.id === id);
    if (!r) return false;
    r.readerToken = newToken();
    found = r;
  });
  return found;
}

function setReaderEnabled(id, enabled) {
  let found = null;
  recipients.mutate((list) => {
    const r = list.find((x) => x.id === id);
    if (!r) return false;
    r.readerEnabled = !!enabled;
    found = r;
  });
  return found;
}

/**
 * Resolve a presented token to its recipient, or null. Constant-time: every
 * stored token is compared (as a sha256 digest) whether or not an earlier one
 * matched, so response timing doesn't leak which tokens exist.
 */
function byToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const presented = crypto.createHash('sha256').update(token).digest();
  let match = null;
  for (const r of recipients.readAll()) {
    // readerEnabled gates EMAILS only (unsubscribe shouldn't brick the shelf
    // link a reader may have bookmarked); the token alone grants page access.
    if (!r.readerToken) continue;
    const stored = crypto.createHash('sha256').update(r.readerToken).digest();
    if (crypto.timingSafeEqual(presented, stored)) match = r;
  }
  return match;
}

// --- books for the picker ------------------------------------------------------

function buildBooks() {
  // Copy-paste bug (fixed): buildLibrary's 2nd arg is a fileExists PREDICATE,
  // not a tag lookup — passing the tag array here made `[]` (truthy) stand in
  // for "file present" always, and never attached tags at all. Match
  // /api/library in src/server.js: a real existsSync predicate, then
  // booktags.attachTags() to actually put tags on the books. Read the tag
  // store once, not once per book.
  // Existence goes through the storage layer (#47): local disk, or the R2 key
  // index (callers load it first via storage.get().ensureIndex()).
  return booktags.attachTags(library.currentBooks(), booktags.readStore());
}

/** PURE: is this book actually sendable — verified AND still on disk? Shared
 *  by every reader-facing book list so nobody's ever offered a "Send" button
 *  for a book that isn't really there. */
function isSendable(b) {
  return !!(b && b.verified && b.filePresent);
}

/** PURE-ish core: which books surface in the "new books" EMAIL digest —
 *  sendable, added within the window. Newest first (buildLibrary's order).
 *  The shelf PAGE itself no longer uses this — see sendableBooks/
 *  booksForReaderPage — this stays scoped to notifyNewBooks below. */
function recentBooks(books, now = Date.now(), days = RECENT_DAYS) {
  const cutoff = now - days * 24 * 3600 * 1000;
  return (books || []).filter((b) => {
    if (!isSendable(b)) return false;
    const at = Date.parse(b.acquiredAt || '');
    return !Number.isNaN(at) && at >= cutoff;
  });
}

/** PURE: every sendable book in the whole library, newest first
 *  (buildLibrary's order, filter preserves it). The reader shelf's full,
 *  unpaginated source list — booksForReaderPage slices a page off this. */
function sendableBooks(books) {
  return (books || []).filter(isSendable);
}

/** PURE: has this book already been sent to this recipient? Sends log `to` as
 *  an array of recipient NAMES (the app's existing convention). */
function sentTo(book, recipient) {
  const name = (recipient.name || '').toLowerCase();
  return (book.sends || []).some((s) =>
    (Array.isArray(s.to) ? s.to : [s.to]).some((t) => String(t || '').toLowerCase() === name)
  );
}

/** The reader's URL for a book's cover image — served (and stored) by
 *  coverstore via /reader/cover, so readers' browsers never hot-link a
 *  catalog and a book with no findable cover still gets a generated jacket.
 *  `v` changes when the stored cover URL does, busting the browser cache. */
function readerCoverUrl(b, recipient) {
  return `/reader/cover?t=${encodeURIComponent(recipient.readerToken || '')}&id=${encodeURIComponent(b.id)}&v=${coverstore.versionFor(b)}`;
}

/** Map one library book to the safe reader-tile payload (id, title, author,
 *  cover, tags, sent). Shared by the shelf and search. No network here: the
 *  cover URL points at /reader/cover, which resolves lazily as each tile's
 *  image loads. */
async function toReaderTile(b, recipient) {
  return {
    id: b.id,
    title: b.title || b.filename || 'Untitled',
    author: b.author || '',
    cover: readerCoverUrl(b, recipient),
    acquiredAt: b.acquiredAt,
    tags: b.tags || [],
    sent: sentTo(b, recipient),
  };
}

/** Re-exported for existing callers/tests; lives in covers.js now. */
const largeCoverUrl = covers.largeCoverUrl;

/** A sendable book by id (fresh library read), or null. Shared by the
 *  details modal and the cover endpoint — so neither can reach a book the
 *  shelf wouldn't show. */
async function findSendableBook(id) {
  if (!id || typeof id !== 'string') return null;
  await storage.get().ensureIndex();
  return sendableBooks(buildBooks()).find((x) => x.id === id) || null;
}

/** Cover image for one shelf book (see coverstore), or null for an id the
 *  shelf doesn't show. */
async function coverImageForReader(id, opts = {}) {
  const b = await findSendableBook(id);
  return b ? coverstore.getCoverImage(b, opts) : null;
}

/**
 * Details for ONE shelf book (the tap-a-book modal): the same safe tile
 * payload plus a larger cover and the catalog blurb. Only sendable books are
 * reachable — an unknown/unsendable id returns null (→ 404), so the endpoint
 * can't be used to probe the rest of history. The blurb comes from the
 * disk-cached covers.resolveMeta (each book looked up at most once); a lookup
 * failure just means no description, never an error.
 * `opts.resolveMeta` is injectable for tests (no network).
 */
async function bookDetailsForReader(recipient, id, opts = {}) {
  const b = await findSendableBook(id);
  if (!b) return null;
  const tile = await toReaderTile(b, recipient);
  const resolve = opts.resolveMeta || covers.resolveMeta;
  let meta = { cover: null, description: null };
  try {
    meta = (await resolve({ title: b.title, author: b.author })) || meta;
  } catch { /* no blurb — the modal still shows the cover + title */ }
  return {
    ...tile,
    // The stored image is already the largest rendition we could find.
    coverLarge: tile.cover,
    description: meta.description || '',
  };
}

/** PURE: slice a page off an ordered list. `hasMore` tells the client whether
 *  to keep observing for the next scroll-triggered page. */
function paginate(list, offset, limit) {
  const source = Array.isArray(list) ? list : [];
  const total = source.length;
  const slice = source.slice(offset, offset + limit);
  return { slice, total, hasMore: offset + slice.length < total };
}

/**
 * One page of the reader's WHOLE library (not just recent), newest first —
 * the shelf's lazy-load source. `offset`/`limit` page through
 * `sendableBooks`, so the same book never straddles two pages as new books
 * are acquired between loads (the underlying order is acquiredAt-desc and
 * stable within a request). Returns `{ books, total, hasMore }`.
 */
async function booksForReaderPage(recipient, offset = 0, limit = PAGE_SIZE) {
  await storage.get().ensureIndex();
  const { slice, total, hasMore } = paginate(sendableBooks(buildBooks()), offset, limit);
  const books = [];
  for (const b of slice) books.push(await toReaderTile(b, recipient));
  return { books, total, hasMore };
}

// A candidate needs at least this much fuzzy evidence (see fuzzyScore) before
// it's considered a real hit for reader search-as-you-type — loose enough to
// forgive typos and partial words, tight enough not to return everything.
const SEARCH_THRESHOLD = 0.55;

// Common short words dropped from per-token fuzzy matching — without this, a
// query like "burning" (which itself contains the substring "in") would
// containment-match the stray word "in" inside an unrelated title like
// "Girls in the Stilt House". They still count toward a whole-string
// substring hit (e.g. searching "the" isn't specially blocked), just not as
// individual token-matching noise.
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'is', 'it', 'its', 'for', 'with', 'by']);

/** PURE: fuzzy match a free-text query against one field (title or author),
 *  in [0,1]. A normalized substring hit (any partial word the user is
 *  mid-typing, e.g. "burning" inside "the burning side") scores highest.
 *  Otherwise, every query token must find its best match — substring or
 *  Levenshtein-similar — among the field's non-stopword words, and the score
 *  is the average of those per-token bests. This is deliberately more
 *  forgiving than `correct.matchScore` (whole-string similarity), which
 *  penalizes a short query against a longer title too harshly for live
 *  search. Containment only grants its shortcut score when both sides are at
 *  least 3 characters, so short words can't spuriously "contain" each other. */
function fuzzyScore(query, field) {
  const nq = normalize(query);
  const nf = normalize(field);
  if (!nq || !nf) return 0;
  if (nf.includes(nq)) return 1;
  const qTokens = nq.split(' ');
  const fTokens = nf.split(' ').filter((w) => !STOPWORDS.has(w));
  const pool = fTokens.length ? fTokens : nf.split(' ');
  let total = 0;
  for (const qt of qTokens) {
    let best = 0;
    for (const ft of pool) {
      const containment = (ft.includes(qt) || qt.includes(ft)) && Math.min(ft.length, qt.length) >= 3;
      best = Math.max(best, containment ? 0.9 : similarity(qt, ft));
    }
    total += best;
  }
  return total / qTokens.length;
}

/** PURE: reader-facing fuzzy library search. Restricts to sendable books
 *  (verified && filePresent), scores each against the free-text query on
 *  BOTH title and author (best of the two wins), keeps hits at/above
 *  SEARCH_THRESHOLD, and returns them best-match-first. Empty/blank query →
 *  []. Typo- and partial-word-tolerant (see fuzzyScore). */
function searchLibrary(books, query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const sendable = sendableBooks(books);
  const scored = [];
  for (const b of sendable) {
    const score = Math.max(fuzzyScore(q, b.title || ''), fuzzyScore(q, b.author || ''));
    if (score >= SEARCH_THRESHOLD) scored.push({ book: b, score });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.map((s) => s.book);
}

/** Search the whole library (not just the recent shelf) for one reader. */
async function searchForReader(recipient, query) {
  await storage.get().ensureIndex();
  const hits = searchLibrary(buildBooks(), query);
  const out = [];
  for (const b of hits) out.push(await toReaderTile(b, recipient));
  return out;
}

/** PURE: decide how a reader's watch request maps onto the existing watchlist.
 *  If an ACTIVE watch already exists for this query, return a merge (the
 *  reader's id added to its recipientIds); otherwise return a create. Works
 *  around watchlist.add()'s silent dedupe that would drop the new recipientId. */
function planReaderWatch(watches, cleaned, recipientId) {
  const key = watchlist.queryKey(cleaned);
  const existing = (watches || []).find((w) => w.status === 'active' && watchlist.queryKey(w) === key);
  if (existing) {
    return { action: 'merge', id: existing.id, recipientIds: [...(existing.recipientIds || []), recipientId] };
  }
  return { action: 'create', input: cleaned };
}

// --- sending ---------------------------------------------------------------------

// Per-reader send throttle: bounds what a leaked link can do to its own
// owner's Kindle (the only thing it CAN do). Generous for a human picking
// books, hostile to a script. In-memory — resets on restart, which is fine
// for an abuse bound.
const SEND_LIMIT = Number(process.env.READER_SEND_LIMIT) || 15;
const SEND_WINDOW_MS = Number(process.env.READER_SEND_WINDOW_MS) || 3600000; // per hour
const _sendLog = new Map(); // recipientId -> [timestamps]

/** PURE-ish (injectable now): record + check one send against the throttle. */
function sendAllowed(recipientId, now = Date.now(), log = _sendLog) {
  const cutoff = now - SEND_WINDOW_MS;
  const times = (log.get(recipientId) || []).filter((t) => t > cutoff);
  if (times.length >= SEND_LIMIT) { log.set(recipientId, times); return false; }
  times.push(now);
  log.set(recipientId, times);
  return true;
}

/**
 * Push one book to the reader's own Kindle. The download entry is resolved
 * server-side from the id (never a client path), must be a VERIFIED download
 * living inside DOWNLOAD_PATH, and the destination is ALWAYS the recipient's
 * stored Kindle address — the token cannot aim a send anywhere else.
 */
async function sendToReader(recipient, downloadId) {
  const downloader = require('./downloader'); // lazy: avoids cycle via watcher
  if (!recipient.kindleEmail) {
    throw Object.assign(new Error('No Kindle address is saved for you yet — ask Eric to add it.'), { code: 'no-kindle' });
  }
  if (!sendAllowed(recipient.id)) {
    throw Object.assign(new Error('That’s a lot of books at once! Give it an hour and try again.'), { code: 'throttled' });
  }
  const gone = () => Object.assign(new Error('That book is no longer available.'), { code: 'gone' });
  const entry = history.findDownload(downloadId);
  if (!entry || !entry.savePath || !entry.verified) throw gone();
  if (!downloader.isSafeEpubPath(entry.savePath, downloader.DOWNLOAD_PATH)) throw gone();
  // The file itself may have been deleted (library cleanup, manual removal)
  // even though history still has a verified entry for it. Without this check
  // a missing file surfaces as a raw 500 from nodemailer's attachment read
  // instead of the intended, friendlier 410 "gone". Existence + bytes go
  // through storage (#47): local disk, or the R2 key index + a GetObject.
  const store = storage.get();
  await store.ensureIndex();
  let onDisk = false;
  try { onDisk = store.existsSync(entry.savePath); } catch { onDisk = false; }
  if (!onDisk) throw gone();
  let att;
  try {
    att = await store.attachment(entry.savePath);
  } catch (err) {
    // The index said present but the object is gone (deleted elsewhere since
    // the last refresh) → the same friendly "gone", not a raw 500.
    if (err && (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404))) throw gone();
    throw err;
  }
  await kindle.pushToKindle({
    kindleEmail: recipient.kindleEmail,
    filename: entry.filename,
    ...att,
  });
  history.logNotify({
    downloadId,
    title: entry.title,
    filename: entry.filename,
    to: [recipient.name],
    kindlePushed: true,
    channels: [{ channel: 'reader', ok: true }],
  });
  return { title: entry.title, kindleEmail: recipient.kindleEmail };
}

// --- reader emails -----------------------------------------------------------------
// Templates live in src/reader-emails.js; the orchestration (who gets which
// email, throttling, cover attachments) stays here.

/** PURE: who gets a feature announcement — readers with a shelf link and an
 *  email, still opted in, and not already sent this announcement id. */
function announcementTargets(list, id) {
  return (list || []).filter((r) =>
    r && r.readerToken && r.email && r.readerEnabled !== false &&
    !(r.readerAnnouncements && r.readerAnnouncements[id]));
}

/** Pick a real shelf book to feature in the announcement: the newest sendable
 *  book that has a cover AND a catalog blurb (checks at most `tries` books).
 *  Null when none qualifies — the email then uses its generic card. */
async function pickAnnouncementSample(opts = {}) {
  const resolve = opts.resolveMeta || covers.resolveMeta;
  const tries = opts.tries || 8;
  await storage.get().ensureIndex();
  for (const b of sendableBooks(buildBooks()).slice(0, tries)) {
    let meta = { cover: null, description: null };
    try { meta = (await resolve({ title: b.title, author: b.author })) || meta; } catch { continue; }
    const cover = b.cover || meta.cover;
    if (cover && meta.description) {
      return { title: b.title, author: b.author || '', cover: largeCoverUrl(cover), description: meta.description };
    }
  }
  return null;
}

/**
 * Send the tap-a-book announcement. Dry run unless `send: true`: returns the
 * target list and the sample without emailing or stamping anyone. Each real
 * send stamps that recipient (fresh read-modify-write, like notifyNewBooks),
 * so a re-run only reaches readers not yet emailed. `only` limits to one
 * recipient id (e.g. send yourself a test first). Never throws per-recipient;
 * failures are reported in the result.
 */
async function announceBookDetails({ send = false, only = null, sample, now = Date.now() } = {}) {
  const id = BOOK_DETAILS_ANNOUNCEMENT;
  let targets = announcementTargets(recipients.readAll(), id);
  if (only) targets = targets.filter((r) => r.id === only || r.email === only);
  const featured = sample !== undefined ? sample : await pickAnnouncementSample();
  const result = { id, dryRun: !send, sample: featured, targets: targets.map((r) => ({ id: r.id, name: r.name, email: r.email })), sent: [], failed: [] };
  if (!send) return result;
  if (!smtp.isConfigured()) throw new Error('SMTP is not configured');
  for (const r of targets) {
    try {
      const msg = buildBookDetailsAnnouncement(r, featured);
      await smtp.getTransport().sendMail({ from: smtp.FROM, to: r.email, ...msg });
      recipients.mutate((fresh) => {
        const target = fresh.find((x) => x.id === r.id);
        if (!target) return false;
        target.readerAnnouncements = { ...(target.readerAnnouncements || {}), [id]: new Date(now).toISOString() };
      });
      result.sent.push(r.email);
    } catch (err) {
      result.failed.push({ email: r.email, error: err.message });
    }
  }
  return result;
}

/** Email the invite (mints the token if needed). */
async function invite(id) {
  const r = ensureToken(id);
  if (!r) throw new Error('Recipient not found');
  if (!r.email) throw new Error('Recipient has no email address');
  if (!smtp.isConfigured()) throw new Error('SMTP is not configured');
  setReaderEnabled(id, true); // an invite (re-)opts them into new-book emails
  const msg = buildInviteEmail(r);
  await smtp.getTransport().sendMail({ from: smtp.FROM, to: r.email, ...msg });
  return r;
}

/**
 * Opportunistic notifier: for each enabled reader, email the books shelved
 * since their last reader email (first email looks back RECENT_DAYS). Self-
 * throttled per reader, so callers can fire it as often as they like. Never
 * throws; returns how many emails went out.
 */
async function notifyNewBooks() {
  if (!smtp.isConfigured()) return 0;
  await storage.get().ensureIndex();
  const now = Date.now();
  const recent = recentBooks(buildBooks(), now);
  if (!recent.length) return 0;
  const list = recipients.readAll();
  let sentCount = 0;
  for (const r of list) {
    if (!r.readerToken || r.readerEnabled === false || !r.email) continue;
    const last = Date.parse(r.readerNotifiedAt || '') || 0;
    if (now - last < NOTIFY_MIN_GAP_MS) continue;
    const fresh = recent.filter((b) => {
      const at = Date.parse(b.acquiredAt || '') || 0;
      return at > last;
    });
    if (!fresh.length) continue;
    try {
      const books = [];
      for (const b of fresh.slice(0, 12)) {
        let cover = b.cover || null;
        if (!cover) {
          try { cover = await covers.resolveCover({ title: b.title, author: b.author }); } catch { /* none */ }
        }
        books.push({ title: b.title || b.filename, author: b.author, cover });
      }
      const msg = buildNewBooksEmail(r, books);
      await smtp.getTransport().sendMail({ from: smtp.FROM, to: r.email, ...msg });
      // Stamp this ONE recipient against a fresh read, right after their send.
      // `list` is only a snapshot of who to email: the sends above take seconds
      // each, so writing the whole snapshot back at the end would revert every
      // recipient added, edited, or deleted while we were sending — and would
      // resurrect a recipient deleted mid-loop.
      recipients.mutate((fresh) => {
        const target = fresh.find((x) => x.id === r.id);
        if (!target) return false; // deleted while we were sending — let it stay deleted
        target.readerNotifiedAt = new Date(now).toISOString();
      });
      sentCount++;
    } catch (err) {
      console.warn('[reader] notify failed for %s: %s', r.email, err.message);
    }
  }
  return sentCount;
}

module.exports = {
  BASE_URL,
  RECENT_DAYS,
  PAGE_SIZE,
  ensureToken,
  rotateToken,
  setReaderEnabled,
  byToken,
  readerLink,
  buildManifest,
  booksForReaderPage,
  searchForReader,
  bookDetailsForReader,
  coverImageForReader,
  sendToReader,
  invite,
  notifyNewBooks,
  announceBookDetails,
  BOOK_DETAILS_ANNOUNCEMENT,
  // exported for unit tests
  recentBooks,
  isSendable,
  sendableBooks,
  paginate,
  sentTo,
  sendAllowed,
  buildNewBooksEmail,
  buildInviteEmail,
  newToken,
  searchLibrary,
  fuzzyScore,
  planReaderWatch,
  toReaderTile,
  largeCoverUrl,
  buildBookDetailsAnnouncement,
  announcementTargets,
  pickAnnouncementSample,
  teaser,
};
