'use strict';

// OpenRouter exposes a public JSON API – no scraping needed.
// Docs: https://openrouter.ai/docs/models
const API_URL = 'https://openrouter.ai/api/v1/models';

// OpenRouter stores per-token prices; multiply by 1e6 to get per-1M price.
const toPerMillion = (val) => (val ? parseFloat(val) * 1_000_000 : 0);

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
  const response = await fetch(API_URL, {
    headers: {
      Accept: 'application/json',
      'HTTP-Referer': 'https://github.com/providers-comparison',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from OpenRouter API`);
  }

  const data = await response.json();
  const models = [];

  for (const model of data.data || []) {
    const pricing = model.pricing || {};
    const inputPrice = toPerMillion(pricing.prompt);
    const outputPrice = toPerMillion(pricing.completion);

    // Skip meta-route with negative prices (e.g. openrouter/auto sentinel values)
    if (inputPrice < 0 || outputPrice < 0) continue;
    // Skip the free-router meta-model (it's not a real model, just routes to free models)
    if (model.id === 'openrouter/free') continue;

    const type = getModelType(model.architecture);
    const capabilities = getCapabilities(model.architecture, model.supported_parameters);

    const modelEntry = {
      name: model.id,
      type,
      input_price_per_1m: Math.round(inputPrice * 10000) / 10000,
      output_price_per_1m: Math.round(outputPrice * 10000) / 10000,
      currency: 'USD',
    };

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
      const free = models.filter(m => m.input_price_per_1m === 0);
      const vision = models.filter(m => m.type === 'vision');
      console.log(`Fetched ${models.length} models from OpenRouter API`);
      console.log(`  Free: ${free.length}, Vision: ${vision.length}`);
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
