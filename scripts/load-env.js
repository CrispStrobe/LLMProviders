'use strict';

/**
 * Shared environment loader.
 *
 * Reads, in order of precedence: the project .env, then ../AIToolkit/.env,
 * then ~/.env for credentials shared across projects on the same machine.
 * Every existing file is read rather than only the first one found, so a key
 * that lives only in the home file is still picked up when a project .env
 * exists for other keys. Earlier files win, and a variable already set in
 * the real environment (as in CI) is never overwritten.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

function loadEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', 'AIToolkit', '.env'),
    path.join(os.homedir(), '.env'),
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        // Strip optional surrounding quotes
        process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
}

module.exports = { loadEnv };
