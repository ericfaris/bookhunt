'use strict';

// Build/version info for the running app. The version is the source of truth in
// package.json (bump with `npm version <major|minor|patch>`); the commit + build
// time are stamped into the Docker image at build (see Dockerfile ARGs / the
// `docker:up` npm script), so the Settings panel can show exactly what's live.

const pkg = require('../package.json');

function info() {
  return {
    version: pkg.version || '0.0.0',
    commit: process.env.GIT_SHA || null,        // short sha, baked at image build
    builtAt: process.env.BUILD_TIME || null,    // ISO timestamp, baked at image build
  };
}

module.exports = { info };
