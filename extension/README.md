# Mooseflip Amazon helper (Chrome/Edge extension)

Adds a **"🔍 Search on Mooseflip"** button near the title on Amazon book pages,
plus a **right-click** entry and a **toolbar-icon** click — any of them opens
your Mooseflip search in a new tab, prefilled with the book's title and author.

## How it works

- `content.js` runs on Amazon product pages, scrapes `#productTitle` and the
  `#bylineInfo` author link, and cleans them with the **same rules** as the app's
  server-side `src/amazon.js` (drops subtitle after a colon, strips `(Author)` /
  edition parentheticals) so results match the in-app Paste button.
- It opens `https://read.mooseflip.com/?title=…&author=…&amazon=<page-url>`.
- The app (`public/app.js` → `prefillFromQuery`) reads those params on load,
  fills the fields, and auto-runs the search. If the DOM scrape is empty, the
  app falls back to scraping the `amazon=` URL server-side via `/api/amazon`.

## Install (unpacked — no Web Store needed)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Visit any Amazon book page — you'll see the button near the title, and
   "Search this book on Mooseflip" in the right-click menu.

## Configuration

The target app URL is the `APP_URL` constant at the top of `content.js`
(default `https://read.mooseflip.com/`). Change it for a local/dev instance.

Add more Amazon locales by extending `host_permissions` + `content_scripts`
matches in `manifest.json` and `documentUrlPatterns` in `background.js`.

## Notes

- No Chrome Web Store listing is required for personal use; "Load unpacked"
  persists across browser restarts.
- The button auto-reattaches across Amazon's in-page navigations via a
  `MutationObserver`, so it survives going from one book to another without a
  full reload.
- Injecting *into Amazon's native share popover* is intentionally avoided — that
  menu is rebuilt by Amazon's JS with rotating class names and breaks often. A
  stable button + context menu is the robust equivalent.
