'use strict';

// OpenRouter exposes a public JSON API – no scraping needed.
// Docs: https://openrouter.ai/docs/models
//
// Without an API key: ~342 models (public subset).
// With an API key:    ~600+ models including image-gen (FLUX, etc.) and subscriber-only models.
// Set OPENROUTER_API_KEY in env or ../AIToolkit/.env to unlock all models.

const { loadEnv } = require('../load-env');
loadEnv();
const { getJson } = require('../fetch-utils');

const API_URL = 'https://openrouter.ai/api/v1/models';
const EU_API_URL = 'https://eu.openrouter.ai/api/v1/models';

// OpenRouter stores per-token prices; multiply by 1e6 to get per-1M price.
const toPerMillion = (val) => (val ? parseFloat(val) * 1_000_000 : 0);

function loadApiKey() {
  return process.env.OPENROUTER_API_KEY || null;
}

const getSizeB = (id) => {
  // Match patterns like 1.2b, 70b, 8b. Support decimals and trailing colon (e.g. 1.2b:free)
  const match = (id || '').match(/(?:\b|-)([\d.]+)[Bb](?:\b|:|$)/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  return (num > 0 && num < 2000) ? num : undefined;
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

  // If we have an API key, use the /user endpoint to get EU-filtered models correctly.
  // Standard /models endpoint doesn't filter by subdomain.
  const globalUrl = apiKey ? `${API_URL}/user` : API_URL;
  const euUrl = apiKey ? `${EU_API_URL}/user` : EU_API_URL;

  process.stdout.write('OpenRouter: fetching Global... ');
  const globalData = await getJson(globalUrl, { headers });
  
  let euModelIds = new Set();
  if (apiKey) {
    process.stdout.write('EU... ');
    try {
      const euData = await getJson(euUrl, { headers });
      if (euData?.data) {
        euModelIds = new Set(euData.data.map(m => m.id));
      }
    } catch (e) {
      console.warn(`\n  ⚠ Failed to fetch EU models: ${e.message}`);
    }
  }

  const models = [];

  for (const model of globalData.data || []) {
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
    
    // Tag with eu-endpoint if model is available via EU subdomain
    if (euModelIds.has(model.id)) {
      capabilities.push('eu-endpoint');
    }

    const modelEntry = {
      name: model.id,
      type,
      input_price_per_1m: Math.round(inputPrice * 10000) / 10000,
      output_price_per_1m: Math.round(outputPrice * 10000) / 10000,
      currency: 'USD',
    };

    if (model.hugging_face_id) modelEntry.hf_id = model.hugging_face_id;

    // For pure image-gen models (no per-token pricing), store the per-image price
    if (imagePrice > 0 && inputPrice === 0 && outputPrice === 0) {
      modelEntry.price_per_image = Math.round(imagePrice * 100000) / 100000;
    }

    if (capabilities.length) modelEntry.capabilities = capabilities;
    const apiParams = model.architecture?.parameters;
    const apiSize = (apiParams && apiParams > 0) ? Math.round(apiParams / 1_000_000_000 * 10) / 10 : null;
    
    // Attempt detection in priority order:
    // 1. Explicit architecture parameters from API
    // 2. Regex on canonical HF ID if provided by OpenRouter
    // 3. Regex on the model description (common for new models missing architecture metadata)
    // 4. Regex on the OpenRouter ID itself
    let sizeB = apiSize;
    if (!sizeB && model.hugging_face_id) sizeB = getSizeB(model.hugging_face_id);
    if (!sizeB && model.description) {
      const descMatch = model.description.match(/([\d.]+)[Bb]-parameter/);
      if (descMatch) sizeB = parseFloat(descMatch[1]);
    }
    if (!sizeB) sizeB = getSizeB(model.id);

    if (sizeB) modelEntry.size_b = sizeB;

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
      const eu = models.filter(m => m.capabilities?.includes('eu-endpoint'));
      console.log(`Fetched ${models.length} models from OpenRouter API ${apiKey ? '(authenticated)' : '(public – set OPENROUTER_API_KEY for more models)'}`);
      console.log(`  Free: ${free.length}, Vision: ${vision.length}, Image-gen: ${imageGen.length}, EU-Endpoint: ${eu.length}`);
      console.log('\nFirst 5 EU-available:');
      eu.slice(0, 5).forEach((m) =>
        console.log(`  ${m.name.padEnd(55)} $${m.input_price_per_1m} / $${m.output_price_per_1m} [${m.type}]`)
      );
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
