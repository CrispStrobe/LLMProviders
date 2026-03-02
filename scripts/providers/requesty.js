'use strict';

const { loadEnv } = require('../load-env');
loadEnv();

const API_URL = 'https://router.requesty.ai/v1/models';

function loadApiKey() {
  return process.env.REQUESTY_API_KEY || null;
}

const toPerMillion = (val) => (val ? Math.round(parseFloat(val) * 1_000_000 * 10000) / 10000 : 0);

const getSizeB = (id) => {
  const match = (id || '').match(/[^.\d](\d+)b/i) || (id || '').match(/^(\d+)b/i);
  return match ? parseInt(match[1]) : undefined;
};

async function fetchRequesty() {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.warn('  (no REQUESTY_API_KEY found – skipping Requesty)');
    return [];
  }

  const response = await fetch(API_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from Requesty API`);
  }

  const data = await response.json();
  const models = [];

  for (const model of data.data || []) {
    const inputPrice = toPerMillion(model.input_price);
    const outputPrice = toPerMillion(model.output_price);

    // Skip free/zero-priced entries
    if (inputPrice <= 0 && outputPrice <= 0) continue;

    const caps = [];
    if (model.supports_vision) caps.push('vision');
    if (model.supports_reasoning) caps.push('reasoning');
    if (model.supports_tool_calls) caps.push('tools');

    const baseType = model.api === 'chat' ? 'chat' : model.api;
    const type = (baseType === 'chat' && model.supports_vision) ? 'vision' : baseType;

    const modelEntry = {
      name: model.id,
      type,
      input_price_per_1m: inputPrice,
      output_price_per_1m: outputPrice,
      currency: 'USD',
    };

    if (caps.length) modelEntry.capabilities = caps;
    if (model.context_window) modelEntry.context_window = model.context_window;

    const size_b = getSizeB(model.id);
    if (size_b) modelEntry.size_b = size_b;

    models.push(modelEntry);
  }

  // Deduplicate @region and :effort variants — keep one entry per canonical base ID.
  // e.g. "anthropic/claude-3-7-sonnet@us-east-2" and "anthropic/claude-3-7-sonnet:high"
  // both collapse to "anthropic/claude-3-7-sonnet".
  const canonicalId = (id) => id.replace(/@[^/]+$/, '').replace(/:[^/]+$/, '');
  const seen = new Map();
  for (const model of models) {
    const base = canonicalId(model.name);
    if (!seen.has(base)) {
      // Store with canonical name
      seen.set(base, { ...model, name: base });
    } else {
      // Prefer lower input price if already present
      const existing = seen.get(base);
      if (model.input_price_per_1m < existing.input_price_per_1m) {
        seen.set(base, { ...model, name: base });
      }
    }
  }
  const deduped = [...seen.values()];

  // Sort by input price
  deduped.sort((a, b) => a.input_price_per_1m - b.input_price_per_1m);

  return deduped;
}

module.exports = { fetchRequesty, providerName: 'Requesty' };

// Run standalone: node scripts/providers/requesty.js
if (require.main === module) {
  fetchRequesty()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Requesty API\n`);
      models.slice(0, 10).forEach((m) =>
        console.log(`  ${m.name.padEnd(55)} $${m.input_price_per_1m} / $${m.output_price_per_1m}`)
      );
      if (models.length > 10) console.log(`  ... and ${models.length - 10} more`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
