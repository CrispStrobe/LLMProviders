'use strict';

/**
 * Shared environment loader.
 *
 * Reads the project .env, plus any additional files listed in PROVIDERS_ENV_FILES
 * (path-separator delimited) for credentials kept outside the repo. Every file
 * that exists is read rather than only the first one found, so a key held
 * elsewhere is still picked up when a local .env exists for other keys.
 * Earlier entries win, and a variable already set in the real environment
 * (as in CI) is never overwritten.
 */

const fs   = require('fs');
const path = require('path');

function readInto(envPath) {
  if (!envPath || !fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      // Strip optional surrounding quotes
      process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

function loadEnv() {
  // Project .env first, so it can itself set PROVIDERS_ENV_FILES and point at
  // credentials held outside the repo.
  readInto(path.join(__dirname, '..', '.env'));

  for (const p of (process.env.PROVIDERS_ENV_FILES || '').split(path.delimiter)) {
    readInto(p.trim());
  }
}

module.exports = { loadEnv };
