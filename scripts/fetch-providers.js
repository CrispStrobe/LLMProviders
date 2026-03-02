'use strict';

/**
 * Fetch live pricing data from all supported providers and update data/providers.json.
 *
 * Usage:
 *   node scripts/fetch-providers.js             # fetch all providers
 *   node scripts/fetch-providers.js scaleway    # fetch only Scaleway
 *   node scripts/fetch-providers.js openrouter  # fetch only OpenRouter
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'providers.json');

// Registry of all available fetchers.
// Each module must export { providerName, fetch<Name> }.
// Add new providers here as scripts/providers/<name>.js modules.
const FETCHER_MODULES = {
  scaleway: require('./providers/scaleway'),
  openrouter: require('./providers/openrouter'),
  requesty: require('./providers/requesty'),
  nebius: require('./providers/nebius'),
  mistral: require('./providers/mistral'),
  langdock: require('./providers/langdock'),
  groq: require('./providers/groq'),
  infomaniak: require('./providers/infomaniak'),
  ionos: require('./providers/ionos'),
  'black-forest-labs': require('./providers/black-forest-labs'),
};

const FETCHERS = Object.entries(FETCHER_MODULES).map(([key, mod]) => {
  // Find the exported async function (the one that isn't providerName)
  const fn = Object.values(mod).find((v) => typeof v === 'function');
  if (!fn) throw new Error(`Module for ${key} exports no function`);
  return { key, providerName: mod.providerName, fn };
});

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function updateProviderModels(providers, providerName, models) {
  const provider = providers.find((p) => p.name === providerName);
  if (!provider) {
    console.warn(`  ⚠  Provider "${providerName}" not found in providers.json – skipping.`);
    return false;
  }
  provider.models = models;
  return true;
}

// Normalize a model name/ID for fuzzy matching (same as App.tsx normalizeName).
const normName = (s) =>
  s.toLowerCase().replace(/[-_.:]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// Build an index of normalized OpenRouter model-part → { capabilities, type }
// Only includes entries that carry non-trivial capability data.
function buildOrIndex(orProvider) {
  if (!orProvider) return [];
  const index = [];
  for (const m of orProvider.models || []) {
    if (!m.capabilities || m.capabilities.length === 0) continue;
    // Strip :free suffix and take the model part after '/'
    const modelPart = m.name.replace(/:free$/, '').split('/').pop();
    index.push({ norm: normName(modelPart), capabilities: m.capabilities, type: m.type });
  }
  return index;
}

// For a given model name, find the best matching OpenRouter index entry.
// Returns { capabilities, type } or null.
function findOrMatch(modelName, orIndex) {
  // Use the model part (after last '/') for matching, strip :region/@suffix
  const raw = modelName.replace(/@[^/]+$/, '').replace(/:[^/]+$/, '');
  const modelPart = raw.includes('/') ? raw.split('/').pop() : raw;
  const n = normName(modelPart);

  // 1. Exact match
  for (const entry of orIndex) {
    if (entry.norm === n) return entry;
  }
  // 2. Provider model name starts with OR model part (e.g. "claude-3-5-sonnet-20241022" starts with "claude-3-5-sonnet")
  let best = null;
  let bestLen = 0;
  for (const entry of orIndex) {
    if (n.startsWith(entry.norm) && entry.norm.length > bestLen) {
      best = entry;
      bestLen = entry.norm.length;
    }
  }
  if (best) return best;
  // 3. OR model part starts with provider name (e.g. "claude-haiku-4-5" → "claude-haiku-4-5-20251001")
  for (const entry of orIndex) {
    if (entry.norm.startsWith(n + ' ')) return entry;
  }
  return null;
}

// Propagate capabilities from OpenRouter to all other providers' models.
// Only fills in capabilities/type when the model doesn't already have them.
function propagateCapabilities(data) {
  const orProvider = data.providers.find((p) => p.name === 'OpenRouter');
  const orIndex = buildOrIndex(orProvider);
  if (orIndex.length === 0) return;

  let propagated = 0;
  let autoTagged = 0;
  for (const provider of data.providers) {
    for (const model of provider.models || []) {
      // Auto-tag image-gen models regardless of OR match
      if (model.type === 'image' && (!model.capabilities || !model.capabilities.length)) {
        model.capabilities = ['image-gen'];
        autoTagged++;
        continue;
      }
      if (provider.name === 'OpenRouter') continue;
      if (model.capabilities && model.capabilities.length > 0) continue; // already set
      const match = findOrMatch(model.name, orIndex);
      if (!match) continue;
      model.capabilities = match.capabilities;
      // Update type only if currently 'chat' (don't demote image/embedding/audio)
      if (model.type === 'chat' && match.type !== 'chat') model.type = match.type;
      propagated++;
    }
  }
  if (autoTagged > 0) console.log(`Auto-tagged ${autoTagged} image-gen models.`);
  if (propagated > 0) console.log(`Propagated capabilities to ${propagated} models from OpenRouter.`);
}

async function runFetcher(fetcher, data) {
  const { key, providerName, fn } = fetcher;

  try {
    process.stdout.write(`Fetching ${providerName}... `);
    const models = await fn();
    const updated = updateProviderModels(data.providers, providerName, models);
    if (updated) console.log(`✓ ${models.length} models`);
    return { key, providerName, success: true, count: models.length };
  } catch (err) {
    console.log(`✗ ${err.message}`);
    return { key, providerName, success: false, error: err.message };
  }
}

async function main() {
  // Determine which fetchers to run
  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const fetchers =
    args.length > 0
      ? FETCHERS.filter((f) => args.includes(f.key))
      : FETCHERS;

  if (fetchers.length === 0) {
    console.error('No matching fetchers found. Available:', FETCHERS.map((f) => f.key).join(', '));
    process.exit(1);
  }

  const data = loadData();
  console.log(`Running ${fetchers.length} fetcher(s)...\n`);

  const results = [];
  for (const fetcher of fetchers) {
    const result = await runFetcher(fetcher, data);
    results.push(result);
  }

  // When all providers are fetched (or OpenRouter was included), propagate capabilities.
  const fetchedKeys = new Set(results.filter((r) => r.success).map((r) => r.key));
  if (fetchedKeys.has('openrouter')) propagateCapabilities(data);

  saveData(data);

  console.log('\nSummary:');
  let anyFailed = false;
  results.forEach((r) => {
    if (r.success) console.log(`  ✓ ${r.providerName}: ${r.count} models`);
    else {
      console.log(`  ✗ ${r.providerName}: ${r.error}`);
      anyFailed = true;
    }
  });

  if (anyFailed) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
