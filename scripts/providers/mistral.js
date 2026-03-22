'use strict';

/**
 * Mistral AI pricing fetcher.
 *
 * mistral.ai/pricing uses Next.js App Router RSC streaming format.
 * Pricing data is embedded in self.__next_f.push([1, "..."]) script tags,
 * NOT in __NEXT_DATA__. We find the script containing "api_grid" and
 * extract the `apis` array which has all models with their price entries.
 */

const URL = 'https://mistral.ai/pricing';
const { getText } = require('../fetch-utils');

const stripHtml = (html) => (html || '').replace(/<[^>]+>/g, '').trim();

const parseUsd = (html) => {
  const text = stripHtml(html);
  if (!text || text === 'N/A' || text === '-') return null;
  // Take the first dollar amount found (handles "X (audio)" / "X (text)" variants)
  const match = text.match(/\$?([\d]+\.[\d]*|[\d]+)/);
  return match ? parseFloat(match[1]) : null;
};

const getSizeB = (name) => {
  const match = (name || '').match(/[^.\d](\d+)[Bb]/) || (name || '').match(/^(\d+)[Bb]/);
  return match ? parseInt(match[1]) : undefined;
};

const MODEL_TYPE_MAP = {
  'embedding models': 'embedding',
  'classifier models': 'chat',
  'open models': 'chat',
  'premier model': 'chat',
  'other models': 'chat',
};

function extractApisArray(payload) {
  // Find the "apis":[...] block in the RSC payload string
  const start = payload.indexOf('"apis":[{');
  if (start === -1) return null;

  // Walk forward from start to find the opening '[' of the array
  let i = start;
  while (i < payload.length && payload[i] !== '[') i++;
  i++; // step past '['
  const arrStart = i;
  let depth = 0;

  while (i < payload.length) {
    if (payload[i] === '[') depth++;
    else if (payload[i] === ']') {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }

  try {
    return JSON.parse('[' + payload.slice(arrStart, i) + ']');
  } catch {
    return null;
  }
}

async function fetchMistral() {
  const html = await getText(URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // The page uses Next.js App Router RSC streaming. Pricing data is in a
  // self.__next_f.push([1, "ENCODED_STRING"]) script tag. Inside the raw HTML,
  // inner quotes are escaped as \" so we search for the literal \\"apis\\":[{
  // (which represents \"apis\":[{ in the actual HTML bytes).
  const MARKER = '\\"apis\\":[{';
  const markerIdx = html.indexOf(MARKER);
  if (markerIdx === -1) throw new Error('Could not find apis marker in page HTML');

  // Find the enclosing <script> tag
  const scriptTagStart = html.lastIndexOf('<script', markerIdx);
  const contentStart = html.indexOf('>', scriptTagStart) + 1;
  const contentEnd = html.indexOf('</script>', contentStart);
  const src = html.slice(contentStart, contentEnd);

  // Format: self.__next_f.push([1,"ENCODED_PAYLOAD"])
  // Extract the JSON-encoded string and parse it once to get the RSC payload string.
  const pushAt = src.indexOf('[1,');
  const strStart = pushAt + 3; // points to opening "
  const lastBracket = src.lastIndexOf('])');
  const jsonStr = src.slice(strStart, lastBracket); // "ENCODED_PAYLOAD"

  let payload;
  try {
    payload = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Failed to parse RSC payload: ${e.message}`);
  }

  const apis = extractApisArray(payload);
  if (!apis) throw new Error('Could not find API pricing data in page');

  const models = [];

  for (const api of apis) {
    const name = (api.name || '').trim();
    const rawType = (api.type || '').toLowerCase();
    const endpoint = api.api_endpoint || null;

    // Skip pure tool entries (no model pricing)
    if (rawType === 'tools' || rawType === 'tool') continue;
    if (!api.price || api.price.length === 0) continue;

    // Find input and output prices from the price array
    let inputPrice = null;
    let outputPrice = null;

    for (const p of api.price) {
      const label = (p.value || '').toLowerCase();
      const priceHtml = p.price_dollar || p.price_euro || '';
      const val = parseUsd(priceHtml);
      if (label.includes('input') || label.includes('in ')) {
        if (inputPrice === null) inputPrice = val;
      } else if (label.includes('output') || label.includes('out ')) {
        if (outputPrice === null) outputPrice = val;
      }
    }

    // Skip if we couldn't get any price
    if (inputPrice === null && outputPrice === null) continue;

    const type = MODEL_TYPE_MAP[rawType] || 'chat';
    const size_b = getSizeB(name);

    const model = {
      name,
      type,
      input_price_per_1m: inputPrice ?? 0,
      output_price_per_1m: outputPrice ?? 0,
      currency: 'USD',
    };
    if (size_b) model.size_b = size_b;
    if (endpoint) model.api_endpoint = endpoint;

    models.push(model);
  }

  return models;
}

module.exports = { fetchMistral, providerName: 'Mistral AI' };

// Run standalone: node scripts/providers/mistral.js
if (require.main === module) {
  fetchMistral()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Mistral AI:\n`);
      const byType = {};
      models.forEach((m) => { (byType[m.type] = byType[m.type] || []).push(m); });
      for (const [type, ms] of Object.entries(byType)) {
        console.log(`  [${type}]`);
        ms.forEach((m) =>
          console.log(`    ${m.name.padEnd(40)} $${m.input_price_per_1m} / $${m.output_price_per_1m}`)
        );
      }
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
