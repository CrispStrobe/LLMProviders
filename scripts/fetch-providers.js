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

  // Smart merge: preserve existing metadata (size_b, hf_id, capabilities, hf_private) if missing in new data
  const existingMap = new Map((provider.models || []).map(m => [m.name, m]));
  
  provider.models = models.map(newModel => {
    const existing = existingMap.get(newModel.name);
    if (!existing) return newModel;

    return {
      ...existing, // Start with existing metadata
      ...newModel, // Overwrite with new prices/type
      // But preserve these if newModel doesn't have them
      size_b: newModel.size_b || existing.size_b,
      hf_id: newModel.hf_id || existing.hf_id,
      hf_private: newModel.hf_private ?? existing.hf_private,
      capabilities: (newModel.capabilities && newModel.capabilities.length > 0) 
        ? newModel.capabilities 
        : existing.capabilities,
    };
  });

  return true;
}

// Normalize a model name/ID for fuzzy matching (same as App.tsx normalizeName).
const normName = (s) =>
  s.toLowerCase().replace(/[-_.:]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// Build an index of normalized OpenRouter model-part → { capabilities, type, size_b, hf_id }
// Only includes entries that carry non-trivial capability data.
function buildOrIndex(orProvider) {
  if (!orProvider) return [];
  const index = [];
  for (const m of orProvider.models || []) {
    if (!m.capabilities || m.capabilities.length === 0) continue;
    // Strip :free suffix and take the model part after '/'
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

// For a given model name, find the best matching OpenRouter index entry.
// Returns { capabilities, type, size_b, hf_id } or null.
function findOrMatch(modelName, orIndex) {
  // Use the model part (after last '/') for matching, strip :region/@suffix
  const raw = modelName.replace(/@[^/]+$/, '').replace(/:[^/]+$/, '');
  const modelPart = raw.includes('/') ? raw.split('/').pop() : raw;
  // Strip reasoning/thinking suffixes that don't appear in OR model IDs
  const n = normName(modelPart).replace(/ (?:reasoning|thinking|extended|nothinking)$/, '');

  // 1. Exact match
  for (const entry of orIndex) {
    if (entry.norm === n) return entry;
  }
  // 2. Provider model name starts with OR model part
  let best = null;
  let bestLen = 0;
  for (const entry of orIndex) {
    if (n.startsWith(entry.norm) && entry.norm.length > bestLen) {
      best = entry;
      bestLen = entry.norm.length;
    }
  }
  if (best) return best;
  // 3. OR model part starts with provider name
  for (const entry of orIndex) {
    if (entry.norm.startsWith(n + ' ')) return entry;
  }
  // 4. OR model norm contains provider name as a contiguous word sequence.
  if (n.length >= 5) {
    let bestC = null, bestCLen = Infinity;
    for (const entry of orIndex) {
      const e = entry.norm;
      if ((e === n || e.includes(' ' + n + ' ') || e.startsWith(n + ' ') || e.endsWith(' ' + n))
          && e.length < bestCLen) {
        bestC = entry; bestCLen = e.length;
      }
    }
    if (bestC) return bestC;
  }
  // 5. All tokens of provider name appear in OR norm.
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
  if (!hfId || hfId.includes(' ') || !hfId.includes('/')) return { error: 'Invalid ID' };
  const token = process.env.HF_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    // Limit to 1 retry for technical metadata lookups
    const data = await getJson(`https://huggingface.co/api/models/${hfId}`, { headers, retries: 1 });
    
    // Check various common metadata locations for total parameters
    let params = data.safetensors?.total || data.config?.total_parameters || data.config?.model_type_params;
    if (!params && data.cardData?.model_details?.parameters) {
      const match = data.cardData.model_details.parameters.match(/([\d.]+)\s*[Bb]/);
      if (match) params = parseFloat(match[1]) * 1_000_000_000;
    }
    
    if (!params) return { error: 'No parameter data in Hub metadata' };
    
    const b = params / 1_000_000_000;
    // Keep 2 decimals for small models (<1B), 1 decimal for others
    const size = b < 1 ? Math.round(b * 100) / 100 : Math.round(b * 10) / 10;
    return { size };
  } catch (e) {
    // Flag as private if we get 401 (unauthorized) or 404 (not found - often private/aliased)
    const isPrivate = e.message.includes('401') || e.message.includes('404');
    return { error: e.message, private: isPrivate };
  }
}

const EMBEDDER_KEYWORDS = ['embed', 'bge', 'gte', 'e5', 'stella', 'minilm', 'multilingual-mpnet'];

// Link common models to their HF IDs when naming is non-standard
const MANUAL_HF_ID_MAP = {
  'all minilm l12 v2': 'sentence-transformers/all-MiniLM-L12-v2',
  'whisper v3': 'openai/whisper-large-v3',
  'whisper large v3': 'openai/whisper-large-v3',
  'step 3 5 flash': 'stepfun-ai/Step-3.5-Flash',
  'bge m3': 'BAAI/bge-m3',
  'lightonocr 2': 'lightonai/LightOnOCR-2-1B',
  'flux 1 schnell': 'black-forest-labs/FLUX.1-schnell',
  'paraphrase multilingual mpnet base v2': 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2',
  'bge large en v1 5': 'BAAI/bge-large-en-v1.5',
  'bge multilingual gemma2': 'BAAI/bge-multilingual-gemma2',
  'photomaker v2': 'TencentARC/PhotoMaker-V2',
  'flux schnell': 'black-forest-labs/FLUX.1-schnell',
  // Qwen mappings
  'qwen3 coder flash': 'Qwen/Qwen2.5-Coder-7B-Instruct', // Counterpart mapping
  'qwen3 coder plus': 'Qwen/Qwen2.5-Coder-32B-Instruct',
  'qwen 3 5 flash': 'Qwen/Qwen2.5-7B-Instruct',
  'qwen vl plus': 'Qwen/Qwen2-VL-7B-Instruct',
  'qwen vl max': 'Qwen/Qwen2-VL-72B-Instruct',
};

const MANUAL_SIZE_MAP = {
  'BAAI/bge-m3': 0.57,
};

// Propagate capabilities and size from benchmarks, OpenRouter, or HF Hub to all other providers' models.
// Only fills in fields when the model doesn't already have them.
async function propagateExtraData(data) {
  const orProvider = data.providers.find((p) => p.name === 'OpenRouter');
  const orIndex = buildOrIndex(orProvider);

  // Load benchmarks for size lookup
  let benchmarks = [];
  try {
    const bmFile = path.join(__dirname, '..', 'data', 'benchmarks.json');
    if (fs.existsSync(bmFile)) benchmarks = JSON.parse(fs.readFileSync(bmFile, 'utf8'));
  } catch (e) { /* ignore */ }

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

  let propagatedCaps = 0;
  let propagatedSize = 0;
  let autoTagged = 0;
  let hfSizeFetched = 0;

  // We'll collect models missing size that have a clear HF-id-like name
  const hfLookupQueue = [];

  for (const provider of data.providers) {
    for (const model of provider.models || []) {
      const n = normName(model.name);

      // 0. MANUAL OVERRIDE: Link common models to their HF IDs
      if (!model.hf_id && MANUAL_HF_ID_MAP[n]) {
        model.hf_id = MANUAL_HF_ID_MAP[n];
      }

      // 1. STRUCTURED LOOKUP: Match size by hf_id if available (Benchmark gold-standard)
      if (!model.size_b && model.hf_id) {
        if (MANUAL_SIZE_MAP[model.hf_id]) {
          model.size_b = MANUAL_SIZE_MAP[model.hf_id];
          propagatedSize++;
        } else {
          const size = hfIdToSize.get(model.hf_id.toLowerCase());
          if (size) { model.size_b = size; propagatedSize++; }
        }
      }


      // 2. AUTO-TAG image-gen and embedding models
      if (model.type === 'image' && (!model.capabilities || !model.capabilities.length)) {
        model.capabilities = ['image-gen'];
        autoTagged++;
      }
      if (model.type === 'chat' && EMBEDDER_KEYWORDS.some(k => n.includes(k))) {
        model.type = 'embedding';
        autoTagged++;
      }

      // 3. FALLBACK: Match size by name against benchmarks
      if (!model.size_b) {
        // Try exact name match or base name match
        const size = bmSizeMap.get(n) || bmSizeMap.get(n.split(' ').pop());
        if (size) {
          model.size_b = size;
          propagatedSize++;
        }
      }

      // 4. INHERIT: Structured data inheritance from OpenRouter
      if (provider.name !== 'OpenRouter') {
        const match = findOrMatch(model.name, orIndex);
        if (match) {
          if (!model.capabilities || model.capabilities.length === 0) {
            // Propagate model capabilities (tools, vision, etc.) but NOT provider-specific ones like eu-endpoint
            model.capabilities = (match.capabilities || []).filter(c => c !== 'eu-endpoint');
            propagatedCaps++;
          }
          if (model.type === 'chat' && match.type !== 'chat') model.type = match.type;

          if (!model.size_b && match.size_b) {
            model.size_b = match.size_b;
            propagatedSize++;
          }
          // Crucial: inherit hf_id to enable Hub API fallback below
          if (!model.hf_id && match.hf_id) model.hf_id = match.hf_id;
          if (model.hf_private === undefined && match.hf_private !== undefined) model.hf_private = match.hf_private;
        }
      }

      // 5. HARDCODED heuristics
      if (!model.size_b) {
        if (n.includes('gemma 2 9b') || n.includes('gemma2 9b')) { model.size_b = 9; propagatedSize++; }
        else if (n.includes('gemma 2 27b') || n.includes('gemma2 27b')) { model.size_b = 27; propagatedSize++; }
        else if (n.includes('gemma 2 2b') || n.includes('gemma2 2b')) { model.size_b = 2; propagatedSize++; }
      }

      // 6. QUEUE: Still missing size? Try Hub API metadata lookup
      // Skip models that we've previously marked as private/unauthorized
      if (!model.size_b && !model.hf_private && (model.name.includes('/') || model.hf_id)) {
        hfLookupQueue.push(model);
      }
    }
  }

  // 7. HUB API: Inspect technical metadata (Limit 200 unique IDs to ensure better coverage)
  const uniqueIds = [...new Set(hfLookupQueue.map(m => m.hf_id || m.name).filter(id => id.includes('/')))].slice(0, 200);
  if (uniqueIds.length > 0) {
    console.log(`\n  HF Hub: technical metadata inspection for ${uniqueIds.length} models...`);
    const idToResult = new Map();
    
    // Process sequentially with small delay to avoid 429 rate limits
    for (let i = 0; i < uniqueIds.length; i++) {
      const id = uniqueIds[i];
      process.stdout.write(`    [${i + 1}/${uniqueIds.length}] ${id.padEnd(50)} `);
      const result = await fetchHFSize(id);
      
      if (result.size) {
        idToResult.set(id, result);
        process.stdout.write(`✓ ${result.size}B\n`);
      } else {
        idToResult.set(id, result);
        process.stdout.write(`✗ ${result.error || 'Unknown Error'}\n`);
        
        // CIRCUIT BREAKER: Stop if we hit a rate limit (429)
        if (result.error && result.error.includes('429')) {
          console.warn('\n  ⚠ HIT RATE LIMIT (429) - Stopping further HF lookups for this run.');
          break;
        }
      }
      await new Promise(r => setTimeout(r, 50)); // Tiny delay
    }

    for (const model of hfLookupQueue) {
      if (!model.size_b) {
        const id = model.hf_id || model.name;
        const result = idToResult.get(id);
        if (result) {
          if (result.size) {
            model.size_b = result.size;
            hfSizeFetched++;
          }
          if (result.private) {
            model.hf_private = true;
          }
        }
      }
    }
    console.log(`  ✓ Total ${hfSizeFetched} new sizes from HF metadata`);
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

  // Always propagate extra data from OpenRouter and Benchmarks to all providers' models.
  await propagateExtraData(data);

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
