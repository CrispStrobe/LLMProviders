'use strict';

/**
 * Fetch live pricing data from all supported providers and update data/providers.json.
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
  if (!provider) return false;

  const existingMap = new Map((provider.models || []).map(m => [m.name, m]));
  
  provider.models = models.map(newModel => {
    const existing = existingMap.get(newModel.name);
    if (!existing) return newModel;

    const merged = {
      ...existing, 
      ...newModel,
      size_b: newModel.size_b || existing.size_b,
      size_source: newModel.size_source || existing.size_source,
      hf_id: newModel.hf_id || existing.hf_id,
      ollama_id: newModel.ollama_id || existing.ollama_id,
      hf_private: newModel.hf_private ?? existing.hf_private,
      audio_price_per_1m: newModel.audio_price_per_1m || existing.audio_price_per_1m,
      capabilities: (newModel.capabilities && newModel.capabilities.length > 0) 
        ? newModel.capabilities 
        : existing.capabilities,
    };

    // If new model uses a different pricing unit, clear the old ones
    if (newModel.price_per_minute !== undefined) {
      delete merged.input_price_per_1m;
      delete merged.output_price_per_1m;
      delete merged.price_per_image;
    } else if (newModel.price_per_image !== undefined) {
      delete merged.input_price_per_1m;
      delete merged.output_price_per_1m;
      delete merged.price_per_minute;
    } else if (newModel.input_price_per_1m !== undefined) {
      delete merged.price_per_image;
      delete merged.price_per_minute;
    }

    return merged;
  });

  return true;
}

const normName = (s) =>
  s.toLowerCase().replace(/[-_.:]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// Estimate parameters from config.json (vLLM style fallback)
function estimateParams(config, hfId) {
  if (!config) return null;
  const h = config.hidden_size || config.d_model || config.n_embd;
  let l = config.num_hidden_layers || config.n_layer;
  const v = config.vocab_size;
  const i = config.intermediate_size || config.d_ff || config.encoder_ffn_dim || config.decoder_ffn_dim;
  const numExperts = config.num_local_experts || config.n_experts || config.num_experts || 1;
  const modelType = (config.model_type || '').toLowerCase();
  const isEncoderDecoder = config.is_encoder_decoder || !!(config.encoder_layers && config.decoder_layers);

  if (isEncoderDecoder) {
    // For encoder-decoder like Whisper/T5, we sum encoder and decoder layers
    l = (config.encoder_layers || l) + (config.decoder_layers || 0);
  }
  
  if (h && l && v) {
    const intermediate = i || (4 * h);
    const vocabParams = v * h;
    const posParams = (config.max_position_embeddings || config.max_source_positions || 512) * h;
    const typeParams = (config.type_vocab_size || 0) * h;
    const embedParams = vocabParams + posParams + typeParams;
    const attentionParams = 4 * (h * h);
    
    // Check if architecture uses GLU (3 weights per MLP layer)
    const hasGlu = ['llama', 'mistral', 'phi3', 'qwen2', 'gemma', 'gemma2', 'minimax'].includes(modelType) 
                   || hfId.toLowerCase().includes('qwen') 
                   || hfId.toLowerCase().includes('minimax');
    
    const mlpParams = (hasGlu ? 3 : 2) * h * intermediate * numExperts;
    const total = embedParams + l * (attentionParams + mlpParams);
    return total;
  }
  return null;
}

// Fetch total_parameters from Hugging Face Hub API
async function fetchHFSize(hfId) {
  if (!hfId || hfId.includes(' ') || !hfId.includes('/')) return { error: 'Invalid ID' };
  const token = process.env.HF_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let isPrivate = false;
  
  try {
    let params = null, source = 'hf-total', data = {};
    
    // 1. API Metadata
    try {
      data = await getJson(`https://huggingface.co/api/models/${hfId}`, { headers, retries: 1 });
      params = data.safetensors?.total || data.config?.total_parameters || data.config?.model_type_params;
      
      if (!params && data.cardData?.model_details?.parameters) {
        const match = data.cardData.model_details.parameters.match(/([\d.]+)\s*[Bb]/);
        if (match) { params = parseFloat(match[1]) * 1_000_000_000; source = 'hf-card'; }
      }
    } catch (e) {
      if (e.message.includes('401') || e.message.includes('404')) isPrivate = true;
    }
    
    // 2. Raw config.json fetch
    if (!params && !isPrivate) {
      try {
        const config = await getJson(`https://huggingface.co/${hfId}/raw/main/config.json`, { headers, retries: 1 });
        params = config.total_parameters || estimateParams(config, hfId);
        source = config.total_parameters ? 'hf-total' : 'hf-config-estimate';
      } catch (e) { 
        if (e.message.includes('401') || e.message.includes('404')) isPrivate = true; 
      }
    }
    
    if (isPrivate) return { error: 'Private or Missing', private: true };
    if (!params) return { error: 'No parameter data found' };
    
    const b = params / 1_000_000_000;
    const size = b < 1 ? Math.round(b * 100) / 100 : Math.round(b * 10) / 10;
    return { size, source };
  } catch (e) { return { error: e.message }; }
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
      return { size, source: 'ollama' };
    }
    return {};
  } catch (e) { return null; }
}

const EMBEDDER_KEYWORDS = ['embed', 'bge', 'gte', 'e5', 'stella', 'minilm', 'multilingual-mpnet'];

const MANUAL_HF_ID_MAP = {
  'minimax/minimax-m1': 'MiniMaxAI/MiniMax-M1-80k',
  'minimax minimax m1': 'MiniMaxAI/MiniMax-M1-80k',
  'minimax m1': 'MiniMaxAI/MiniMax-M1-80k',
  'qwen plus': 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'alibaba qwen plus': 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'qwen qwen plus': 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'phi 4': 'microsoft/phi-4',
  'mistral small 4': 'mistralai/Mistral-Small-4-119B-2603',
  'mistral small 3 2': 'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
  'mistral small 3 1': 'mistralai/Mistral-Small-3.1-24B-Instruct-2503',
  'mistral small 2501': 'mistralai/Mistral-Small-24B-Instruct-2501',
  'mistral small 2409': 'mistralai/Mistral-Small-Instruct-2409',
  'mistral small 24b': 'mistralai/Mistral-Small-24B-Instruct-2501',
  'whisper large v3': 'openai/whisper-large-v3',
  'whisper large v3 turbo': 'openai/whisper-large-v3-turbo',
  'whisper large v2': 'openai/whisper-large-v2',
  'whisper medium': 'openai/whisper-medium',
  'whisper small': 'openai/whisper-small',
  'whisper base': 'openai/whisper-base',
  'whisper tiny': 'openai/whisper-tiny',
  'gemini 3.1 pro': 'google/gemini-3.1-pro-preview',
  'gemini 3.1 flash lite': 'google/gemini-3.1-flash-lite-preview',
  'gemini 3 flash': 'google/gemini-3-flash-preview',
  'voxtral mini': 'mistralai/Voxtral-Mini-3B-2507',
  'voxtral realtime': 'mistralai/Voxtral-Mini-4B-Realtime-2602',
  'voxtral mini transcribe 2': 'mistralai/Voxtral-Mini-3B-2507',
  'voxtral small': 'mistralai/Voxtral-Small-24B-2507',
  'mistral large 3': 'mistralai/Mistral-Large-Instruct-2407',
  'mistral small 3': 'mistralai/Mistral-Small-Instruct-2409',
  'ministral 3 - 3b': 'mistralai/Ministral-3b-instruct-2410',
  'ministral 3 - 8b': 'mistralai/Ministral-8b-instruct-2410',
  'devstral 2': 'mistralai/Devstral-2-123B-Instruct-2512',
  'mistral embed': 'mistralai/mistral-embed',
  'codestral embed': 'mistralai/mistral-embed',
  'e5 mistral 7b instruct': 'intfloat/e5-mistral-7b-instruct',
  'qwen3-embedding-8b': 'Qwen/Qwen3-Embedding-8B',
  'bge-multilingual-gemma2': 'BAAI/bge-multilingual-gemma2',
  'bge-en-icl': 'BAAI/bge-en-icl',
};

const MANUAL_OLLAMA_ID_MAP = {
  'phi 4': 'phi4',
  'deepseek chat': 'deepseek-v3',
  'deepseek reasoner': 'deepseek-r1',
  'mistral small 24b': 'mistral-small',
};

const MANUAL_SIZE_MAP = {
  'BAAI/bge-m3': 0.57,
  'black-forest-labs/FLUX.1-schnell': 12,
  'black-forest-labs/FLUX.1-dev': 12,
  'black-forest-labs/FLUX.1-pro': 12,
  'black-forest-labs/FLUX.2-dev': 32,
  'black-forest-labs/FLUX.2-pro': 32,
  'black-forest-labs/FLUX.2-flex': 32,
  'black-forest-labs/FLUX.2-max': 32,
  'black-forest-labs/FLUX.2-klein-4B': 4,
  'black-forest-labs/FLUX.2-klein-9B': 9,
  'openai/whisper-large-v3': 1.55,
  'openai/whisper-large-v3-turbo': 0.81,
  'openai/whisper-large-v2': 1.55,
  'openai/whisper-medium': 0.77,
  'openai/whisper-small': 0.24,
  'openai/whisper-base': 0.07,
  'openai/whisper-tiny': 0.04,
  'google/gemini-3.1-pro-preview': 292,
  'google/gemini-3.1-flash-lite-preview': 371,
  'google/gemini-3-flash-preview': 1000,
  'xiaomi/mimo-v2-omni': 186,
  'mistralai/Voxtral-Mini-3B-2507': 3,
  'mistralai/Voxtral-Mini-4B-Realtime-2602': 4,
  'mistralai/Voxtral-Small-24B-2507': 24,
  'mistralai/Mistral-Large-Instruct-2407': 123,
  'mistralai/Mistral-Small-Instruct-2409': 22,
  'mistralai/Ministral-3b-instruct-2410': 3,
  'mistralai/Ministral-8b-instruct-2410': 8,
  'mistralai/Devstral-2-123B-Instruct-2512': 123,
};

const PROPRIETARY_KEYWORDS = [
  'gpt-4', 'gpt-5', 'sonnet', 'opus', 'haiku', 'gemini', 'o1-', 'o3-', 'o4-', 'claude',
  'magistral', 'voxtral', 'moderation', 'embed'
];

async function propagateExtraData(data) {
  let benchmarks = [];
  try { benchmarks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'benchmarks.json'), 'utf8')); } catch (e) {}
  const hfIdToSize = new Map();
  benchmarks.forEach((b) => { if (b.params_b && b.hf_id) hfIdToSize.set(b.hf_id.toLowerCase(), b.params_b); });

  // 1. Initial manual and fuzzy mapping
  data.providers.forEach(p => p.models.forEach(model => {
    const n = normName(model.name);
    for (const [key, val] of Object.entries(MANUAL_HF_ID_MAP)) {
      if (n === key || n.endsWith(' ' + key) || n.endsWith('/' + key)) { 
        model.hf_id = val; model.hf_private = false; break; 
      }
    }
    if (PROPRIETARY_KEYWORDS.some(k => n.includes(k)) && !model.hf_id) model.hf_private = true;
    for (const [key, val] of Object.entries(MANUAL_OLLAMA_ID_MAP)) {
      if (n === key || n.endsWith(' ' + key) || n.endsWith('/' + key)) model.ollama_id = val;
    }
    if (model.hf_id && MANUAL_SIZE_MAP[model.hf_id]) {
      model.size_b = MANUAL_SIZE_MAP[model.hf_id]; model.size_source = 'manual';
    } else if (model.hf_id && !model.size_b) {
      const size = hfIdToSize.get(model.hf_id.toLowerCase());
      if (size) { model.size_b = size; model.size_source = 'benchmark'; }
    }
  }));

  // 2. Technical Metadata Lookups
  const hfLookupQueue = [];
  data.providers.forEach(p => p.models.forEach(m => {
    if (!m.size_b && m.hf_id && !m.hf_private) hfLookupQueue.push(m);
  }));

  const uniqueIds = [...new Set(hfLookupQueue.map(m => m.hf_id))];
  if (uniqueIds.length > 0) {
    console.log(`\n  HF Hub: technical metadata inspection for ${uniqueIds.length} models...`);
    const idToResult = new Map();
    for (const id of uniqueIds) {
      process.stdout.write(`    ${id.padEnd(50)} `);
      const result = await fetchHFSize(id);
      idToResult.set(id, result);
      if (result.size) process.stdout.write(`✓ ${result.size}B (${result.source})\n`);
      else process.stdout.write(`✗ ${result.error || 'Err'}\n`);
      await new Promise(r => setTimeout(r, 50));
    }
    for (const model of hfLookupQueue) {
      if (!model.size_b) {
        const id = model.hf_id;
        const result = idToResult.get(id);
        if (result && result.size) { 
          model.size_b = result.size; 
          model.size_source = result.source; 
          model.hf_private = false;
        }
      }
    }
  }

  // 3. GLOBAL ENRICHMENT SWEEP
  const technicalPool = new Map(); 
  data.providers.forEach(p => p.models.forEach(m => {
    const baseName = m.name.split('/').pop().replace(/:free$/, '').toLowerCase();
    if (m.size_b || m.hf_id || (m.capabilities && m.capabilities.length > 0)) {
      const meta = { 
        size_b: m.size_b, 
        size_source: m.size_source, 
        hf_id: m.hf_id, 
        ollama_id: m.ollama_id, 
        hf_private: m.hf_private,
        capabilities: m.capabilities
      };
      if (m.hf_id) technicalPool.set('id:' + m.hf_id.toLowerCase(), meta);
      technicalPool.set('name:' + baseName, meta);
    }
  }));

  data.providers.forEach(p => p.models.forEach(m => {
    const baseName = m.name.split('/').pop().replace(/:free$/, '').toLowerCase();
    const metaByName = technicalPool.get('name:' + baseName);
    const metaById = m.hf_id ? technicalPool.get('id:' + m.hf_id.toLowerCase()) : null;
    const best = metaById || metaByName;
    if (best) {
      m.size_b = m.size_b || best.size_b;
      m.size_source = m.size_source || best.size_source;
      m.hf_id = m.hf_id || best.hf_id;
      m.ollama_id = m.ollama_id || best.ollama_id;
      if (best.capabilities && (!m.capabilities || m.capabilities.length === 0)) {
        m.capabilities = best.capabilities;
      }
      if (m.size_b || m.hf_id) m.hf_private = false;
    }
  }));
}

async function main() {
  const data = loadData();
  for (const f of FETCHERS) {
    try {
      process.stdout.write(`Fetching ${f.providerName}... `);
      const models = await f.fn();
      if (updateProviderModels(data.providers, f.providerName, models)) console.log(`✓ ${models.length} models`);
    } catch (err) { console.log(`✗ ${err.message}`); }
  }
  await propagateExtraData(data);
  saveData(data);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
