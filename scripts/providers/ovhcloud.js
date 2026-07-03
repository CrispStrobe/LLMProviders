'use strict';

/**
 * OVHcloud AI Endpoints — EU-sovereign (France), pay-per-token, OpenAI-compatible.
 *
 * The public catalog page is a Next.js app that embeds the full model list
 * (categories, capabilities, HF source links and per-unit pricing) in its
 * streamed `self.__next_f.push([...])` payload. We reconstruct that payload,
 * pull out the `"models":[ ... ]` array and map it to our schema. This is far
 * more robust than scraping the rendered price DOM.
 */

const cheerio = require('cheerio');
const { getText } = require('../fetch-utils');

const URL = 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/';

// Reconstruct the decoded Next.js flight payload from all push() chunks.
function decodeNextPayload(html) {
  const $ = cheerio.load(html);
  let decoded = '';
  const re = /self\.__next_f\.push\(\[\d+,("(?:[^"\\]|\\.)*")\]\)/g;
  $('script').each((_, el) => {
    const c = $(el).html() || '';
    if (!c.includes('__next_f.push')) return;
    let m;
    while ((m = re.exec(c))) {
      // The second arg is a JSON string literal — JSON.parse decodes the escapes.
      try { decoded += JSON.parse(m[1]); } catch (e) { /* skip malformed chunk */ }
    }
  });
  return decoded;
}

// Bracket-match the JSON array that follows the first `"models":[` occurrence.
function extractModelsArray(decoded) {
  const key = '"models":[';
  const at = decoded.indexOf(key);
  if (at === -1) return null;
  const start = at + key.length - 1; // position of the opening '['
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < decoded.length; j++) {
    const ch = decoded[j];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { return decoded.slice(start, j + 1); } }
  }
  return null;
}

const getType = (category, caps) => {
  const c = (category || '').toLowerCase();
  if (c.includes('embedding')) return 'embedding';
  if (c.includes('speech') || c.includes('audio')) return 'audio';
  if (c.includes('image generation')) return 'image';
  if ((caps.input_modality || []).includes('image')) return 'vision';
  return 'chat';
};

const getSizeB = (name) => {
  const match = (name || '').match(/(?:\b|-)([\d.]+)[Bb](?:\b|-|:|$)/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  return (num > 0 && num < 2000) ? num : undefined;
};

const hfIdFromModel = (m) => {
  const link = m.metadata?.publishing_information?.source_link || '';
  if (link.includes('huggingface.co/')) {
    return link.split('huggingface.co/')[1].replace(/\/+$/, '') || undefined;
  }
  // Fall back to an alias that looks like an HF id (publisher/model).
  const alias = (m.metadata?.aliases || []).find((a) => a.includes('/'));
  return alias || undefined;
};

function mapModel(m) {
  const caps = m.metadata?.model_specs?.capabilities || {};
  const type = getType(m.category, caps);
  const pricing = m.metadata?.usage_information?.pricing || [];

  const model = { name: m.name || m.id, type, currency: 'EUR' };

  // Capabilities
  const capList = [];
  if ((caps.input_modality || []).includes('image')) capList.push('vision');
  if (caps.function_calling) capList.push('tools');
  if (caps.reasoning) capList.push('reasoning');
  if (type === 'image') capList.push('image-gen');
  if (type === 'audio') capList.push('audio');
  if (capList.length) model.capabilities = capList;

  // Pricing — map OVH's per-unit entries onto our fields.
  const priceBy = {};
  pricing.forEach((p) => { priceBy[p.price_unit] = p.price; });

  if (priceBy.per_image !== undefined) {
    model.price_per_image = priceBy.per_image;
  } else if (priceBy.audio_duration_seconds !== undefined) {
    // Store per-minute to match the app's audio convention.
    model.price_per_minute = Math.round(priceBy.audio_duration_seconds * 60 * 1e6) / 1e6;
  } else {
    // Token/char based (chat, vision, embedding, code, moderation, TTS).
    const input = priceBy.million_input_tokens ?? priceBy.million_input_chars ?? 0;
    const output = priceBy.million_output_tokens ?? 0;
    model.input_price_per_1m = input;
    model.output_price_per_1m = output;
  }

  const hf_id = hfIdFromModel(m);
  if (hf_id) model.hf_id = hf_id;

  const size_b = getSizeB(m.name || m.id);
  if (size_b) model.size_b = size_b;

  return model;
}

async function fetchOvhcloud() {
  const html = await getText(URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const decoded = decodeNextPayload(html);
  const raw = extractModelsArray(decoded);
  if (!raw) throw new Error('Could not locate embedded models payload (page structure changed?)');

  let models;
  try {
    models = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse embedded models JSON: ${e.message}`);
  }

  return models
    .filter((m) => m && m.name && m.available !== false)
    .map(mapModel);
}

module.exports = { fetchOvhcloud, providerName: 'OVHcloud' };

// Run standalone: node scripts/providers/ovhcloud.js
if (require.main === module) {
  fetchOvhcloud()
    .then((models) => {
      console.log(`Fetched ${models.length} models from OVHcloud:\n`);
      models.forEach((m) => {
        const price = m.price_per_image !== undefined
          ? `€${m.price_per_image}/img`
          : m.price_per_minute !== undefined
            ? `€${m.price_per_minute}/min`
            : `€${m.input_price_per_1m} / €${m.output_price_per_1m}`;
        console.log(`  ${m.name.padEnd(42)} ${m.type.padEnd(10)} ${price}`);
      });
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
