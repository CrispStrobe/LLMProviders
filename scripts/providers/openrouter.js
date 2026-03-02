'use strict';

// OpenRouter exposes a public JSON API – no scraping needed.
// Docs: https://openrouter.ai/docs/models
//
// Without an API key: ~342 models (public subset).
// With an API key:    ~600+ models including image-gen (FLUX, etc.) and subscriber-only models.
// Set OPENROUTER_API_KEY in env or ../AIToolkit/.env to unlock all models.

const { loadEnv } = require('../load-env');
loadEnv();

const API_URL = 'https://openrouter.ai/api/v1/models';

// OpenRouter stores per-token prices; multiply by 1e6 to get per-1M price.
const toPerMillion = (val) => (val ? parseFloat(val) * 1_000_000 : 0);

function loadApiKey() {
  return process.env.OPENROUTER_API_KEY || null;
}

const getSizeB = (id) => {
  const match = (id || '').match(/[^.\d](\d+)b/i) || (id || '').match(/^(\d+)b/i);
  return match ? parseInt(match[1]) : undefined;
};

// Derive model type from architecture modalities.
function getModelType(architecture) {
  if (!architecture) return 'chat';
  const inMods = architecture.input_modalities || [];
  const outMods = architecture.output_modalities || [];
  if (outMods.includes('audio')) return 'audio';
  if (outMods.includes('image')) return 'image';
  if (inMods.includes('image') || inMods.includes('video')) return 'vision';
  if (inMods.includes('audio')) return 'audio';
  return 'chat';
}

// Derive capabilities array from modalities + supported parameters.
function getCapabilities(architecture, supportedParams) {
  const caps = [];
  const inMods = (architecture?.input_modalities || []);
  const outMods = (architecture?.output_modalities || []);
  const params = supportedParams || [];
  if (inMods.includes('image')) caps.push('vision');
  if (inMods.includes('video')) caps.push('video');
  if (inMods.includes('audio')) caps.push('audio');
  if (inMods.includes('file')) caps.push('files');
  if (outMods.includes('image')) caps.push('image-gen');
  if (outMods.includes('audio')) caps.push('audio-out');
  if (params.includes('tools')) caps.push('tools');
  if (params.includes('reasoning')) caps.push('reasoning');
  return caps;
}

async function fetchOpenRouter() {
  const apiKey = loadApiKey();
  const headers = {
    Accept: 'application/json',
    'HTTP-Referer': 'https://github.com/providers-comparison',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(API_URL, { headers });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from OpenRouter API`);
  }

  const data = await response.json();
  const models = [];

  for (const model of data.data || []) {
    const pricing = model.pricing || {};
    const inputPrice = toPerMillion(pricing.prompt);
    const outputPrice = toPerMillion(pricing.completion);
    // pricing.image: per-image cost for image-gen models (e.g. FLUX) — in USD per image
    // (NOT the same as per-pixel input cost on vision models like Gemini, which also have prompt price set)
    const imagePrice = parseFloat(pricing.image || '0');

    // Skip meta-routes with sentinel negative prices (e.g. openrouter/auto)
    if (inputPrice < 0 || outputPrice < 0) continue;
    // Skip the free-router meta-model
    if (model.id === 'openrouter/free') continue;
    // Skip models with genuinely zero pricing across all fields (unpriced/placeholder entries).
    // Exception: models with a :free suffix are real free models and should be kept.
    if (inputPrice === 0 && outputPrice === 0 && imagePrice === 0 && !model.id.endsWith(':free')) continue;

    const type = getModelType(model.architecture);
    const capabilities = getCapabilities(model.architecture, model.supported_parameters);

    const modelEntry = {
      name: model.id,
      type,
      input_price_per_1m: Math.round(inputPrice * 10000) / 10000,
      output_price_per_1m: Math.round(outputPrice * 10000) / 10000,
      currency: 'USD',
    };

    // For pure image-gen models (no per-token pricing), store the per-image price
    if (imagePrice > 0 && inputPrice === 0 && outputPrice === 0) {
      modelEntry.price_per_image = Math.round(imagePrice * 100000) / 100000;
    }

    if (capabilities.length) modelEntry.capabilities = capabilities;
    const size_b = getSizeB(model.id);
    if (size_b) modelEntry.size_b = size_b;

    models.push(modelEntry);
  }

  // Sort: free first (price=0), then by input price
  models.sort((a, b) => {
    const aFree = a.input_price_per_1m === 0 ? 1 : 0;
    const bFree = b.input_price_per_1m === 0 ? 1 : 0;
    if (aFree !== bFree) return aFree - bFree; // paid first, free last
    return a.input_price_per_1m - b.input_price_per_1m;
  });

  return models;
}

module.exports = { fetchOpenRouter, providerName: 'OpenRouter' };

// Run standalone: node scripts/providers/openrouter.js
if (require.main === module) {
  fetchOpenRouter()
    .then((models) => {
      const apiKey = loadApiKey();
      const free = models.filter(m => m.input_price_per_1m === 0 && !m.price_per_image);
      const vision = models.filter(m => m.type === 'vision');
      const imageGen = models.filter(m => m.type === 'image');
      console.log(`Fetched ${models.length} models from OpenRouter API ${apiKey ? '(authenticated)' : '(public – set OPENROUTER_API_KEY for more models)'}`);
      console.log(`  Free: ${free.length}, Vision: ${vision.length}, Image-gen: ${imageGen.length}`);
      console.log('\nFirst 5 paid:');
      models.filter(m => m.input_price_per_1m > 0).slice(0, 5).forEach((m) =>
        console.log(`  ${m.name.padEnd(55)} $${m.input_price_per_1m} / $${m.output_price_per_1m} [${m.type}] ${(m.capabilities||[]).join(',')}`)
      );
      console.log('\nFirst 5 free:');
      free.slice(0, 5).forEach((m) =>
        console.log(`  ${m.name.padEnd(55)} [${m.type}] ${(m.capabilities||[]).join(',')}`)
      );
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
