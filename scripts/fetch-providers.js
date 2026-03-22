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
const { getJson, getText, fetchRobust } = require('./fetch-utils');

const DATA_FILE = path.join(__dirname, '..', 'data', 'providers.json');

// Registry of all available fetchers.
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

const normName = (s) =>
  s.toLowerCase().replace(/[-_.:]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function buildOrIndex(orProvider) {
  if (!orProvider) return [];
  const index = [];
  for (const m of orProvider.models || []) {
    if (!m.capabilities || m.capabilities.length === 0) continue;
    const modelPart = m.name.replace(/:free$/, '').split('/').pop();
    index.push({
      norm: normName(modelPart),
      capabilities: m.capabilities,
      type: m.type,
      size_b: m.size_b,
      hf_id: m.hf_id,
    });
  }
  return index;
}

function findOrMatch(modelName, orIndex) {
  const raw = modelName.replace(/@[^/]+$/, '').replace(/:[^/]+$/, '');
  const modelPart = raw.includes('/') ? raw.split('/').pop() : raw;
  const n = normName(modelPart).replace(/ (?:reasoning|thinking|extended|nothinking)$/, '');

  for (const entry of orIndex) if (entry.norm === n) return entry;
  let best = null, bestLen = 0;
  for (const entry of orIndex) {
    if (n.startsWith(entry.norm) && entry.norm.length > bestLen) {
      best = entry; bestLen = entry.norm.length;
    }
  }
  if (best) return best;
  for (const entry of orIndex) if (entry.norm.startsWith(n + ' ')) return entry;
  if (n.length >= 5) {
    let bestC = null, bestCLen = Infinity;
    for (const entry of orIndex) {
      const e = entry.norm;
      if ((e === n || e.includes(' ' + n + ' ') || e.startsWith(n + ' ') || e.endsWith(' ' + n)) && e.length < bestCLen) {
        bestC = entry; bestCLen = e.length;
      }
    }
    if (bestC) return bestC;
  }
  const tokens = n.split(' ');
  if (tokens.length >= 2 && n.length >= 7) {
    let bestT = null, bestTLen = Infinity;
    for (const entry of orIndex) {
      const eTokens = entry.norm.split(' ');
      if (tokens.every((t) => eTokens.includes(t)) && entry.norm.length < bestTLen) {
        bestT = entry; bestTLen = entry.norm.length;
      }
    }
    if (bestT) return bestT;
  }
  return null;
}

// Fetch total_parameters from Hugging Face Hub API (Metadata)
async function fetchHFSize(hfId) {
  if (!hfId || hfId.includes(' ') || !hfId.includes('/')) return null;
  const token = process.env.HF_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const data = await getJson(`https://huggingface.co/api/models/${hfId}`, { headers });
    let params = data.safetensors?.total || data.config?.total_parameters || data.config?.model_type_params;
    if (!params && data.cardData?.model_details?.parameters) {
      const match = data.cardData.model_details.parameters.match(/([\d.]+)\s*[Bb]/);
      if (match) params = parseFloat(match[1]) * 1_000_000_000;
    }
    return params ? Math.round(params / 1_000_000_000 * 10) / 10 : null;
  } catch (e) { return null; }
}

const EMBEDDER_KEYWORDS = ['embed', 'bge', 'gte', 'e5', 'stella', 'minilm', 'multilingual-mpnet'];

async function propagateExtraData(data) {
  const orProvider = data.providers.find((p) => p.name === 'OpenRouter');
  const orIndex = buildOrIndex(orProvider);

  let benchmarks = [];
  try {
    const bmFile = path.join(__dirname, '..', 'data', 'benchmarks.json');
    if (fs.existsSync(bmFile)) benchmarks = JSON.parse(fs.readFileSync(bmFile, 'utf8'));
  } catch (e) {}

  // Multi-level Benchmark Size Maps
  const bmSizeMap = new Map();
  const hfIdToSize = new Map();
  benchmarks.forEach((b) => {
    if (b.params_b) {
      if (b.hf_id) hfIdToSize.set(b.hf_id.toLowerCase(), b.params_b);
      if (b.name) bmSizeMap.set(normName(b.name), b.params_b);
      if (b.lb_name) bmSizeMap.set(normName(b.lb_name), b.params_b);
    }
  });

  let propagatedCaps = 0, propagatedSize = 0, autoTagged = 0, hfSizeFetched = 0;
  const hfLookupQueue = [];

  for (const provider of data.providers) {
    for (const model of provider.models || []) {
      const n = normName(model.name);

      // 1. STRUCTURED LOOKUP: Match size by hf_id if available (Benchmark gold-standard)
      if (!model.size_b && model.hf_id) {
        const size = hfIdToSize.get(model.hf_id.toLowerCase());
        if (size) { model.size_b = size; propagatedSize++; }
      }

      // 2. AUTO-TAG type
      if (model.type === 'image' && (!model.capabilities || !model.capabilities.length)) {
        model.capabilities = ['image-gen']; autoTagged++;
      }
      if (model.type === 'chat' && EMBEDDER_KEYWORDS.some(k => n.includes(k))) {
        model.type = 'embedding'; autoTagged++;
      }

      // 3. FALLBACK: Match size by name against benchmarks
      if (!model.size_b) {
        const size = bmSizeMap.get(n) || bmSizeMap.get(n.split(' ').pop());
        if (size) { model.size_b = size; propagatedSize++; }
      }

      // 4. INHERIT: Structured data inheritance from OpenRouter
      if (provider.name !== 'OpenRouter') {
        const match = findOrMatch(model.name, orIndex);
        if (match) {
          if (!model.capabilities || model.capabilities.length === 0) { model.capabilities = match.capabilities; propagatedCaps++; }
          if (model.type === 'chat' && match.type !== 'chat') model.type = match.type;
          if (!model.size_b && match.size_b) { model.size_b = match.size_b; propagatedSize++; }
          // Crucial: inherit hf_id to enable Hub API fallback below
          if (!model.hf_id && match.hf_id) model.hf_id = match.hf_id;
        }
      }

      // 5. HARDCODED heuristics
      if (!model.size_b) {
        if (n.includes('gemma 2 9b') || n.includes('gemma2 9b')) { model.size_b = 9; propagatedSize++; }
        else if (n.includes('gemma 2 27b') || n.includes('gemma2 27b')) { model.size_b = 27; propagatedSize++; }
        else if (n.includes('gemma 2 2b') || n.includes('gemma2 2b')) { model.size_b = 2; propagatedSize++; }
      }

      // 6. QUEUE: Still missing size? Try Hub API metadata lookup
      if (!model.size_b && (model.name.includes('/') || model.hf_id)) hfLookupQueue.push(model);
    }
  }

  // 7. HUB API: Inspect technical metadata (Limit 30 to prevent timeouts)
  const uniqueIds = [...new Set(hfLookupQueue.map(m => m.hf_id || m.name).filter(id => id.includes('/')))].slice(0, 30);
  if (uniqueIds.length > 0) {
    process.stdout.write(`  HF Hub: technical metadata inspection for ${uniqueIds.length} models... `);
    const idToSize = new Map();
    await Promise.all(uniqueIds.map(async (id) => {
      const size = await fetchHFSize(id);
      if (size) idToSize.set(id, size);
    }));
    for (const model of hfLookupQueue) {
      if (!model.size_b) {
        const size = idToSize.get(model.hf_id || model.name);
        if (size) { model.size_b = size; hfSizeFetched++; }
      }
    }
    console.log(`✓ ${hfSizeFetched} sizes found`);
  }

  if (autoTagged > 0) console.log(`Auto-tagged ${autoTagged} image-gen/embedding models.`);
  if (propagatedCaps > 0) console.log(`Propagated capabilities to ${propagatedCaps} models.`);
  if (propagatedSize + hfSizeFetched > 0) console.log(`Enriched size data for ${propagatedSize + hfSizeFetched} models.`);
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
  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const fetchers = args.length > 0 ? FETCHERS.filter((f) => args.includes(f.key)) : FETCHERS;
  if (fetchers.length === 0) {
    console.error('No matching fetchers found. Available:', FETCHERS.map((f) => f.key).join(', '));
    process.exit(1);
  }
  const data = loadData();
  console.log(`Running ${fetchers.length} fetcher(s)...\n`);
  const results = [];
  for (const fetcher of fetchers) results.push(await runFetcher(fetcher, data));
  await propagateExtraData(data);
  saveData(data);
  console.log('\nSummary:');
  let anyFailed = false;
  results.forEach((r) => {
    if (r.success) console.log(`  ✓ ${r.providerName}: ${r.count} models`);
    else { console.log(`  ✗ ${r.providerName}: ${r.error}`); anyFailed = true; }
  });
  if (anyFailed) process.exit(1);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
