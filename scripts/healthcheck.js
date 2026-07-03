'use strict';

/**
 * Provider fetcher health check.
 *
 * Runs every provider fetcher and asserts it still returns a sane number of
 * models. This catches the failure mode where an upstream page/API changes
 * shape and a scraper silently returns 0 (or throws) — as happened when Nebius
 * rebranded to Token Factory and Mistral moved to Astro.
 *
 * Exit code:
 *   0 — all checked providers healthy
 *   1 — one or more providers broke (below their minimum, or threw)
 *
 * Providers that require an API key are only checked when that key is present
 * in the environment; otherwise they are reported as SKIP (neutral), so the
 * check still passes on forks / environments without secrets.
 *
 * Usage: node scripts/healthcheck.js
 */

const path = require('path');
// Load local .env (project or ../AIToolkit) so keyed-provider detection is
// deterministic before we probe process.env. No-op in CI (uses real secrets).
require('./load-env').loadEnv();

// key: provider module under scripts/providers/
// min: lowest model count we still consider healthy (set well below the live
//      count so normal catalog churn never trips it, but a broken scraper does)
// keyEnv: env var required to reach the source (null = public scrape)
const CHECKS = [
  { key: 'scaleway',          min: 8,   keyEnv: null },
  { key: 'ovhcloud',          min: 10,  keyEnv: null },
  { key: 'stackit',           min: 4,   keyEnv: null },
  { key: 'mistral',           min: 10,  keyEnv: null },
  { key: 'langdock',          min: 12,  keyEnv: null },
  { key: 'groq',              min: 5,   keyEnv: null },
  { key: 'infomaniak',        min: 6,   keyEnv: null },
  { key: 'ionos',             min: 5,   keyEnv: null },
  { key: 'black-forest-labs', min: 6,   keyEnv: null },
  { key: 'nebius',            min: 10,  keyEnv: null },
  { key: 'nscale',            min: 5,   keyEnv: 'NSCALE_API_KEY' },
  { key: 'requesty',          min: 40,  keyEnv: null },
  { key: 'openrouter',        min: 80,  keyEnv: null },
];

const TIMEOUT_MS = 120000;

function loadFetcher(key) {
  const mod = require(path.join(__dirname, 'providers', key));
  const fn = Object.values(mod).find((v) => typeof v === 'function');
  if (!fn) throw new Error(`module ${key} exports no fetcher function`);
  return { fn, providerName: mod.providerName || key };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]).catch((e) => { throw new Error(`${label}: ${e.message}`); });
}

async function main() {
  const results = [];

  for (const check of CHECKS) {
    const { key, min, keyEnv } = check;
    let providerName = key;

    if (keyEnv && !process.env[keyEnv]) {
      results.push({ key, providerName, status: 'SKIP', count: null, note: `no ${keyEnv}` });
      continue;
    }

    try {
      const { fn, providerName: name } = loadFetcher(key);
      providerName = name;
      const models = await withTimeout(Promise.resolve().then(fn), TIMEOUT_MS, key);
      const count = Array.isArray(models) ? models.length : 0;
      if (count >= min) {
        results.push({ key, providerName, status: 'PASS', count, note: `>= ${min}` });
      } else {
        results.push({ key, providerName, status: 'FAIL', count, note: `expected >= ${min}` });
      }
    } catch (err) {
      results.push({ key, providerName, status: 'FAIL', count: null, note: err.message });
    }
  }

  // Report
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\nProvider fetcher health check\n' + '='.repeat(60));
  for (const r of results) {
    const mark = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '–' : '✗';
    const count = r.count == null ? '' : `${r.count} models`;
    console.log(`  ${mark} ${pad(r.status, 5)} ${pad(r.providerName, 20)} ${pad(count, 12)} ${r.note}`);
  }
  console.log('='.repeat(60));

  const failed = results.filter((r) => r.status === 'FAIL');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`  ${passed} passed, ${failed.length} failed, ${skipped} skipped\n`);

  if (failed.length) {
    console.error('BROKEN FETCHERS: ' + failed.map((r) => r.providerName).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Health check crashed:', err);
  process.exit(1);
});
