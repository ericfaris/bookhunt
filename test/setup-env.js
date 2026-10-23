'use strict';

// Loaded before every test file (npm test: node --test --import). The repo-root
// JSON files are the LIVE production data (bind-mounted into the container), so
// every store is pointed at a throwaway dir; a test that needs a specific file
// still sets its own env var before requiring the module. DATA_STORE=file keeps
// Atlas out of tests entirely.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-test-stores-'));
const files = {
  HISTORY_FILE: 'history.json',
  WATCHLIST_FILE: 'watchlist.json',
  RECIPIENTS_FILE: 'recipients.json',
  RECIPIENT_GROUPS_FILE: 'recipient-groups.json',
  SETTINGS_FILE: 'settings.json',
  BOOKTAGS_FILE: 'booktags.json',
  LISTS_FILE: 'lists.json',
  COVERS_CACHE_FILE: 'covers-cache.json',
};
for (const [key, name] of Object.entries(files)) {
  if (!process.env[key]) process.env[key] = path.join(dir, name);
}
process.env.DATA_STORE = 'file';
delete process.env.MONGODB_URI;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
