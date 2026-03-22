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

  // Smart merge: preserve existing metadata (size_b, hf_id, ollama_id, capabilities, hf_private)
  const existingMap = new Map((provider.models || []).map(m => [m.name, m]));
  
  provider.models = models.map(newModel => {
    const existing = existingMap.get(newModel.name);
    if (!existing) return newModel;

    return {
      ...existing, // Start with existing metadata
      ...newModel, // Overwrite with new prices/type
      size_b: newModel.size_b || existing.size_b,
      hf_id: newModel.hf_id || existing.hf_id,
      ollama_id: newModel.ollama_id || existing.ollama_id,
      hf_private: newModel.hf_private ?? existing.hf_private,
      capabilities: (newModel.capabilities && newModel.capabilities.length > 0) 
        ? newModel.capabilities 
        : existing.capabilities,
    };
  });

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

// Estimate parameters from config.json (vLLM style fallback)
function estimateParams(config) {
  if (!config) return null;
  const h = config.hidden_size || config.d_model || config.n_embd;
  const l = config.num_hidden_layers || config.n_layer;
  const v = config.vocab_size;
  const i = config.intermediate_size || config.d_ff;
  if (h && l && v) {
    const intermediate = i || (4 * h);
    const params = (v * h) + l * (4 * (h * h) + 2 * (h * intermediate));
    return params;
  }
  return null;
}

// Fetch total_parameters from Hugging Face Hub API
async function fetchHFSize(hfId) {
  if (!hfId || hfId.includes(' ') || !hfId.includes('/')) return { error: 'Invalid ID' };
  const token = process.env.HF_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const data = await getJson(`https://huggingface.co/api/models/${hfId}`, { headers, retries: 1 });
    let params = data.safetensors?.total || data.config?.total_parameters || data.config?.model_type_params;
    if (!params && data.cardData?.model_details?.parameters) {
      const match = data.cardData.model_details.parameters.match(/([\d.]+)\s*[Bb]/);
      if (match) params = parseFloat(match[1]) * 1_000_000_000;
    }
    if (!params && data.config) params = estimateParams(data.config);
    if (!params) return { error: 'No parameter data' };
    const b = params / 1_000_000_000;
    const size = b < 1 ? Math.round(b * 100) / 100 : Math.round(b * 10) / 10;
    return { size };
  } catch (e) {
    const isPrivate = e.message.includes('401') || e.message.includes('404');
    return { error: e.message, private: isPrivate };
  }
}

async function fetchOllamaMetadata(ollamaId) {
  const url = `https://registry.ollama.ai/v2/library/${ollamaId}/manifests/latest`;
  try {
    const data = await getJson(url, { headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' }, retries: 1 });
    if (!data.config?.digest) return null;
    const config = await getJson(`https://registry.ollama.ai/v2/library/${ollamaId}/blobs/${data.config.digest}`, { retries: 1 });
    const info = config.model_info || {};
    const count = info['general.parameter_count'] || info['parameter_count'];
    if (count) {
      const b = count / 1_000_000_000;
      const size = b < 1 ? Math.round(b * 100) / 100 : Math.round(b * 10) / 10;
      return { size };
    }
    return {};
  } catch (e) { return null; }
}

const EMBEDDER_KEYWORDS = ['embed', 'bge', 'gte', 'e5', 'stella', 'minilm', 'multilingual-mpnet'];

// Technical hardcoded mappings: Provider normalized names -> Official Repo IDs
const MANUAL_HF_ID_MAP = {
  'all minilm l12 v2': 'sentence-transformers/all-MiniLM-L12-v2',
  'whisper v3': 'openai/whisper-large-v3',
  'whisper large v3': 'openai/whisper-large-v3',
  'step 3 5 flash': 'stepfun-ai/Step-3.5-Flash',
  'bge m3': 'BAAI/bge-m3',
  'lightonocr 2': 'lightonai/LightOnOCR-2-1B',
  'flux 1 schnell': 'black-forest-labs/FLUX.1-schnell',
  'flux schnell': 'black-forest-labs/FLUX.1-schnell',
  'paraphrase multilingual mpnet base v2': 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2',
  'bge large en v1 5': 'BAAI/bge-large-en-v1.5',
  'bge multilingual gemma2': 'BAAI/bge-multilingual-gemma2',
  'photomaker v2': 'TencentARC/PhotoMaker-V2',
  // Qwen
  'qwen turbo': 'Alibaba/Qwen-Turbo',
  'alibaba qwen turbo': 'Alibaba/Qwen-Turbo',
  'qwen plus': 'Alibaba/Qwen-Plus',
  'alibaba qwen plus': 'Alibaba/Qwen-Plus',
  'qwen max': 'Alibaba/Qwen-Max',
  'alibaba qwen max': 'Alibaba/Qwen-Max',
  'qwen 3 coder flash': 'Qwen/Qwen2.5-Coder-7B-Instruct',
  'qwen3 coder flash': 'Qwen/Qwen2.5-Coder-7B-Instruct',
  'qwen 3 coder plus': 'Qwen/Qwen2.5-Coder-32B-Instruct',
  'qwen3 coder plus': 'Qwen/Qwen2.5-Coder-32B-Instruct',
  'qwen 3 5 flash': 'Qwen/Qwen2.5-7B-Instruct',
  'qwen3 5 flash 02 23': 'Qwen/Qwen2.5-7B-Instruct',
  'qwen3 5 plus 02 15': 'Qwen/Qwen2.5-32B-Instruct',
  'qwen vl plus': 'Qwen/Qwen2-VL-7B-Instruct',
  'qwen vl max': 'Qwen/Qwen2-VL-72B-Instruct',
  // DeepSeek
  'deepseek chat': 'deepseek-ai/DeepSeek-V3',
  'deepseek reasoner': 'deepseek-ai/DeepSeek-R1',
  'deepseek v3 turbo': 'deepseek-ai/DeepSeek-V3',
  'deepseek v3 0324 fast': 'deepseek-ai/DeepSeek-V3',
  'deepseek r1t2 chimera': 'deepseek-ai/DeepSeek-R1',
  'deepseek v3 2 exp': 'deepseek-ai/DeepSeek-V3.2',
  'deepseek v3 2 speciale': 'deepseek-ai/DeepSeek-V3.2',
  // Grok
  'grok 4 1 fast': 'xai-org/grok-fast',
  'grok 4 fast': 'xai-org/grok-fast',
  'grok code fast 1': 'xai-org/grok-code',
  'grok 3 mini': 'xai-org/grok-mini',
  'grok 3 mini beta': 'xai-org/grok-mini',
  'grok 4 20 multi agent beta': 'xai-org/grok-4',
  'grok 4 20 beta': 'xai-org/grok-4',
  'grok 4': 'xai-org/grok-4',
  'grok 3': 'xai-org/grok-3',
  'grok 3 beta': 'xai-org/grok-3',
  'grok 2 1212': 'xai-org/grok-2',
  // GLM
  'glm 4 6v': 'THUDM/glm-4v-9b',
  'glm 5 turbo': 'THUDM/glm-5-turbo',
  // MiniMax
  'minimax m2 7': 'MiniMax/MiniMax-M2.7',
  'minimax 01': 'MiniMax/MiniMax-Text-01',
  // Microsoft
  'phi 4': 'microsoft/phi-4',
  // FLUX
  'flux 1 dev': 'black-forest-labs/FLUX.1-dev',
  'flux dev': 'black-forest-labs/FLUX.1-dev',
  'flux 2 dev': 'black-forest-labs/FLUX.2-dev',
  'flux 2 klein 4b': 'black-forest-labs/FLUX.2-klein-4B',
  'flux 2 klein 9b': 'black-forest-labs/FLUX.2-klein-9B',
  'flux 2 pro': 'black-forest-labs/FLUX.2-pro',
  'flux 1 pro': 'black-forest-labs/FLUX.1-pro',
  'flux 2 flex': 'black-forest-labs/FLUX.2-flex',
  'flux 2 max': 'black-forest-labs/FLUX.2-max',
};

const MANUAL_OLLAMA_ID_MAP = {
  'phi 4': 'phi4',
  'deepseek chat': 'deepseek-v3',
  'deepseek reasoner': 'deepseek-r1',
  'codestral': 'codestral',
  'mistral small 24b': 'mistral-small',
  'llama 3 1 8b': 'llama3.1:8b',
  'llama 3 3 70b': 'llama3.3',
  'gemma 2 9b': 'gemma2:9b',
  'gemma 2 27b': 'gemma2:27b',
  'qwen 2 5 coder 7b': 'qwen2.5-coder:7b',
  'qwen 2 5 coder 32b': 'qwen2.5-coder:32b',
};

async function propagateExtraData(data) {
  const orProvider = data.providers.find((p) => p.name === 'OpenRouter');
  const orIndex = buildOrIndex(orProvider);
  let benchmarks = [];
  try { benchmarks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'benchmarks.json'), 'utf8')); } catch (e) {}
  const hfIdToSize = new Map();
  benchmarks.forEach((b) => {
    if (b.params_b && b.hf_id) hfIdToSize.set(b.hf_id.toLowerCase(), b.params_b);
  });

  let propagatedCaps = 0, propagatedSize = 0, autoTagged = 0, hfSizeFetched = 0, ollamaFetched = 0;
  const hfLookupQueue = [], ollamaLookupQueue = [];

  for (const provider of data.providers) {
    for (const model of provider.models || []) {
      const n = normName(model.name);
      
      // Technical metadata resolution (Manual Mapping)
      if (!model.hf_id) {
        for (const [key, val] of Object.entries(MANUAL_HF_ID_MAP)) {
          if (n === key || n.endsWith(' ' + key) || n.endsWith('/' + key)) { model.hf_id = val; break; }
        }
      }
      if (!model.ollama_id) {
        for (const [key, val] of Object.entries(MANUAL_OLLAMA_ID_MAP)) {
          if (n === key || n.endsWith(' ' + key) || n.endsWith('/' + key)) { model.ollama_id = val; break; }
        }
      }

      // Propagate size from benchmarks (Exact Match via hf_id)
      if (!model.size_b && model.hf_id) {
        const size = hfIdToSize.get(model.hf_id.toLowerCase());
        if (size) { model.size_b = size; propagatedSize++; }
      }

      if (model.type === 'image' && (!model.capabilities || !model.capabilities.length)) { model.capabilities = ['image-gen']; autoTagged++; }
      if (model.type === 'chat' && EMBEDDER_KEYWORDS.some(k => n.includes(k))) { model.type = 'embedding'; autoTagged++; }

      if (provider.name !== 'OpenRouter') {
        const match = findOrMatch(model.name, orIndex);
        if (match) {
          if (!model.capabilities || model.capabilities.length === 0) {
            model.capabilities = (match.capabilities || []).filter(c => c !== 'eu-endpoint');
            propagatedCaps++;
          }
          if (model.type === 'chat' && match.type !== 'chat') model.type = match.type;
          if (!model.size_b && match.size_b) { model.size_b = match.size_b; propagatedSize++; }
          if (!model.hf_id && match.hf_id) model.hf_id = match.hf_id;
          if (!model.ollama_id && match.ollama_id) model.ollama_id = match.ollama_id;
          if (model.hf_private === undefined && match.hf_private !== undefined) model.hf_private = match.hf_private;
        }
      }

      if (!model.size_b) {
        if (!model.hf_private && (model.name.includes('/') || model.hf_id)) hfLookupQueue.push(model);
        else if (!model.hf_private && model.ollama_id) ollamaLookupQueue.push(model);
      }
    }
  }

  const uniqueIds = [...new Set(hfLookupQueue.map(m => m.hf_id || m.name).filter(id => id.includes('/')))].slice(0, 200);
  if (uniqueIds.length > 0) {
    console.log(`\n  HF Hub: metadata inspection for ${uniqueIds.length} models...`);
    const idToResult = new Map();
    for (let i = 0; i < uniqueIds.length; i++) {
      const id = uniqueIds[i];
      process.stdout.write(`    [${i + 1}/${uniqueIds.length}] ${id.padEnd(50)} `);
      const result = await fetchHFSize(id);
      idToResult.set(id, result);
      if (result.size) process.stdout.write(`✓ ${result.size}B\n`);
      else {
        process.stdout.write(`✗ ${result.error || 'Err'}\n`);
        if (result.error && result.error.includes('429')) break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    for (const model of hfLookupQueue) {
      const id = model.hf_id || model.name;
      const result = idToResult.get(id);
      if (result) {
        if (result.size && !model.size_b) { model.size_b = result.size; hfSizeFetched++; }
        if (result.private) model.hf_private = true;
      }
    }
  }

  const uniqueOllama = [...new Set(ollamaLookupQueue.map(m => m.ollama_id))].filter(Boolean);
  if (uniqueOllama.length > 0) {
    console.log(`\n  Ollama: inspecting registry for ${uniqueOllama.length} models...`);
    const idToResult = new Map();
    for (let i = 0; i < uniqueOllama.length; i++) {
      const id = uniqueOllama[i];
      process.stdout.write(`    [${i + 1}/${uniqueOllama.length}] ${id.padEnd(50)} `);
      const res = await fetchOllamaMetadata(id);
      if (res) { idToResult.set(id, res); process.stdout.write(res.size ? `✓ ${res.size}B\n` : `✓\n`); }
      else process.stdout.write(`✗\n`);
      await new Promise(r => setTimeout(r, 50));
    }
    for (const model of ollamaLookupQueue) {
      const res = idToResult.get(model.ollama_id);
      if (res && res.size && !model.size_b) { model.size_b = res.size; ollamaFetched++; }
    }
  }
  console.log(`\nEnriched: ${propagatedSize + hfSizeFetched + ollamaFetched} sizes, ${propagatedCaps} caps, ${autoTagged} tags.`);
}

async function runFetcher(fetcher, data) {
  try {
    process.stdout.write(`Fetching ${fetcher.providerName}... `);
    const models = await fetcher.fn();
    if (updateProviderModels(data.providers, fetcher.providerName, models)) console.log(`✓ ${models.length} models`);
    return { ...fetcher, success: true, count: models.length };
  } catch (err) {
    console.log(`✗ ${err.message}`);
    return { ...fetcher, success: false, error: err.message };
  }
}

async function main() {
  const data = loadData();
  const args = process.argv.slice(2).map(a => a.toLowerCase());
  const fetchers = args.length > 0 ? FETCHERS.filter(f => args.includes(f.key)) : FETCHERS;
  console.log(`Running ${fetchers.length} fetcher(s)...\n`);
  for (const f of fetchers) await runFetcher(f, data);
  await propagateExtraData(data);
  saveData(data);
  console.log('\nSummary:');
  data.providers.forEach(p => console.log(`  ${p.models ? '✓' : '✗'} ${p.name}: ${p.models ? p.models.length : 0} models`));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
