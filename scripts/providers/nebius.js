'use strict';

/**
 * Nebius Token Factory (formerly Nebius AI Studio) pricing fetcher.
 *
 * The public "Model endpoints" page (tokenfactory.nebius.com/endpoints) lists
 * every shared model with pricing to anonymous users. It loads that data from
 * a CSRF-protected proxy endpoint — no API key required:
 *
 *   GET https://tokenfactory.nebius.com/proxy/inference/private/v1/models_info
 *
 * To call it we first load the app once to obtain an anonymous CSRF cookie
 * (__Host-psifi.x-csrf-token), then replay it as both the Cookie and the
 * x-csrf-token header. The response is richer than the authenticated
 * /v1/models API: each model carries huggingface_url, size_b, vendor, tags and
 * `flavors` with per-million-token prices.
 *
 *   { models: [ { type, name, huggingface_url, size_b, flavors: [
 *       { model_id, model_type, label, input_price_per_million_tokens,
 *         output_price_per_million_tokens, use_cases, tags, context_window_k } ] } ] }
 */

const { fetchRobust } = require('../fetch-utils');

const BOOTSTRAP_URL = 'https://tokenfactory.nebius.com/endpoints';
const MODELS_URL = 'https://tokenfactory.nebius.com/proxy/inference/private/v1/models_info';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Load the app once to mint an anonymous CSRF token (returned as a cookie).
async function getCsrf() {
  const res = await fetchRobust(BOOTSTRAP_URL, { headers: { 'User-Agent': UA } });
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/__Host-psifi\.x-csrf-token=([^;,]+)/);
  if (!m) throw new Error('could not obtain CSRF cookie from Token Factory');
  const cookieVal = m[1];
  const headerVal = decodeURIComponent(cookieVal).split('|')[0];
  return { cookieVal, headerVal };
}

const getType = (modelType) => {
  const t = (modelType || '').toLowerCase();
  if (t.includes('embedding')) return 'embedding';
  if (t === 'image2text' || t.includes('vision')) return 'vision';
  if (t === 'text2image' || t.includes('image_generation')) return 'image';
  return 'chat';
};

const hfIdFrom = (model, flavor) => {
  const url = model.huggingface_url || '';
  if (url.includes('huggingface.co/')) return url.split('huggingface.co/')[1].replace(/\/+$/, '');
  const id = flavor.model_id || '';
  return /^[^/\s]+\/[^/\s]+$/.test(id) ? id : undefined;
};

function buildEntry(model, flavor, labelSuffix) {
  const type = getType(flavor.model_type || model.type);
  const input = Number(flavor.input_price_per_million_tokens);
  const output = Number(flavor.output_price_per_million_tokens);

  const caps = [];
  const uses = (flavor.use_cases || []).map((u) => u.toLowerCase());
  const tags = (flavor.tags || model.tags || []).map((t) => t.toLowerCase());
  if (type === 'vision') caps.push('vision');
  if (uses.includes('function_calling') || tags.includes('tool use')) caps.push('tools');
  if (uses.includes('reasoning') || tags.includes('reasoning')) caps.push('reasoning');

  const entry = {
    name: model.name + (labelSuffix ? ` (${labelSuffix})` : ''),
    type,
    input_price_per_1m: isFinite(input) ? input : 0,
    output_price_per_1m: isFinite(output) ? output : 0,
    currency: 'USD',
  };
  if (caps.length) entry.capabilities = caps;

  const hf_id = hfIdFrom(model, flavor);
  if (hf_id) entry.hf_id = hf_id;

  const size_b = Number(model.size_b) || undefined;
  if (size_b) entry.size_b = size_b;

  const ctx = Number(flavor.context_window_k || model.context_window_k);
  if (ctx) entry.context_window = ctx * 1000;

  return entry;
}

async function fetchNebius() {
  const { cookieVal, headerVal } = await getCsrf();

  const res = await fetchRobust(MODELS_URL, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'x-csrf-token': headerVal,
      Cookie: `__Host-psifi.x-csrf-token=${cookieVal}`,
    },
  });
  const data = await res.json();
  const list = data.models || data.data || (Array.isArray(data) ? data : []);

  const models = [];
  for (const model of list) {
    const flavors = Array.isArray(model.flavors) && model.flavors.length ? model.flavors : [{}];
    const multi = flavors.length > 1;
    for (const flavor of flavors) {
      // Only label-suffix when a model exposes several priced variants.
      const suffix = multi ? (flavor.label || flavor.quantization) : '';
      const entry = buildEntry(model, flavor, suffix);
      if (entry.input_price_per_1m > 0 || entry.output_price_per_1m > 0) models.push(entry);
    }
  }

  models.sort((a, b) => a.input_price_per_1m - b.input_price_per_1m);
  return models;
}

module.exports = { fetchNebius, providerName: 'Nebius' };

// Run standalone: node scripts/providers/nebius.js
if (require.main === module) {
  fetchNebius()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Nebius (public models_info):\n`);
      const byType = {};
      models.forEach((m) => { (byType[m.type] = byType[m.type] || []).push(m); });
      for (const [type, ms] of Object.entries(byType)) {
        console.log(`  [${type}]`);
        ms.forEach((m) =>
          console.log(`    ${m.name.padEnd(45)} $${m.input_price_per_1m} / $${m.output_price_per_1m}`)
        );
      }
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
