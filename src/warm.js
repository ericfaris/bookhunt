'use strict';

// Warms the persistent browser profile for a NON-DOCKER (host) setup: opens a
// real headed browser via WSLg, logs into Mobilism (clearing any Cloudflare
// challenge), and saves the session to .browser-profile/.
//
//   DISPLAY=:0 npm run warm
//
// NOTE: The Docker deployment no longer uses this. There the browser runs headed
// under Xvfb in the container and is warmed remotely via the /warm noVNC page —
// see the README "Re-warming" section. This script remains only for local,
// non-containerized runs where the WSLg Chromium window is usable.

require('dotenv').config();
const searcher = require('./searcher');

(async () => {
  if (process.env.HEADLESS === 'true') {
    console.error('Refusing to warm in headless mode — Cloudflare login needs a real display.');
    console.error('Run it as:  DISPLAY=:0 npm run warm');
    process.exit(1);
  }
  console.log('Opening a browser to log in (a Chromium window will appear)…');
  const { page } = await searcher.getSession();
  await searcher.ensureReady(page); // submit login / wait for a manual Cloudflare solve
  console.log('✓ Logged in. Session saved to .browser-profile/');
  await searcher.closeSession();
  process.exit(0);
})().catch((err) => {
  console.error('Warm failed:', err.message);
  process.exit(1);
});
