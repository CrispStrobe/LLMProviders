'use strict';

/**
 * Shared environment loader.
 * Checks local project .env first, then ../AIToolkit/.env as a fallback.
 * Only sets variables that are not already present in process.env.
 */

const fs   = require('fs');
const path = require('path');

function loadEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', 'AIToolkit', '.env'),
  ];
  const envPath = candidates.find((p) => fs.existsSync(p));
  if (!envPath) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      // Strip optional surrounding quotes
      process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

module.exports = { loadEnv };
