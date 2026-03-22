'use strict';

/**
 * Black Forest Labs (bfl.ai) pricing fetcher.
 *
 * bfl.ai/pricing uses Next.js App Router RSC streaming.
 * Pricing data is embedded in self.__next_f.push([1,"..."]) script tags,
 * delivered as Sanity CMS portable text via a `pricingCards` array.
 *
 * Each card has:
 *   title       – portable text array → plain model name
 *   priceUnit   – USD price per first generated megapixel (1MP = 1024×1024)
 *   apiEndpoint – REST endpoint slug (e.g. /v1/flux-2-max)
 *   category    – { name } for model family (FLUX.2, FLUX.1, FLUX.1 Tools, …)
 *
 * We store priceUnit as price_per_image (cost for a standard 1MP / 1024×1024 image).
 */

const URL = 'https://bfl.ai/pricing';
const { getText } = require('../fetch-utils');

// Extract plain text from Sanity portable text blocks.
function portableTextToString(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .flatMap((b) => (b.children || []).map((s) => s.text || ''))
    .join('')
    .trim();
}

// Bracket-count extract a JSON array starting after `marker` in `str`.
function extractJsonArray(str, marker) {
  const markerIdx = str.indexOf(marker);
  if (markerIdx < 0) return null;
  let i = markerIdx + marker.length;
  while (i < str.length && str[i] !== '[') i++;
  i++; // past opening '['
  let depth = 0;
  let end = -1;
  for (let j = i; j < str.length; j++) {
    if (str[j] === '[' || str[j] === '{') depth++;
    else if (str[j] === ']' || str[j] === '}') {
      if (depth === 0) { end = j; break; }
      depth--;
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse('[' + str.slice(i, end) + ']');
  } catch {
    return null;
  }
}

async function fetchBfl() {
  const html = await getText(URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Decode all RSC payload chunks
  let combined = '';
  const pushRe = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let m;
  while ((m = pushRe.exec(html)) !== null) {
    try { combined += JSON.parse('"' + m[1] + '"'); } catch { /* skip malformed */ }
  }

  if (!combined) throw new Error('No RSC payload found in page');

  const cards = extractJsonArray(combined, '"pricingCards":');
  if (!cards) throw new Error('Could not find pricingCards in RSC payload');

  const models = [];
  for (const card of cards) {
    const name = portableTextToString(card.title);
    const priceUnit = parseFloat(card.priceUnit || '0');
    const endpoint = (card.apiEndpoint || '').replace(/^\/v1\//, '');
    const family = card.category?.name || 'BFL';

    if (!name || priceUnit <= 0) continue;

    models.push({
      // Use the API endpoint slug as the model ID for stability
      name: endpoint || name,
      display_name: name,
      type: 'image',
      capabilities: ['image-out'],
      // priceUnit = USD per first generated megapixel (1024×1024)
      price_per_image: priceUnit,
      input_price_per_1m: 0,
      output_price_per_1m: 0,
      currency: 'USD',
      category: family,
    });
  }

  // Sort by price ascending
  models.sort((a, b) => a.price_per_image - b.price_per_image);

  return models;
}

module.exports = { fetchBfl, providerName: 'Black Forest Labs' };

// Run standalone: node scripts/providers/bfl.js
if (require.main === module) {
  fetchBfl()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Black Forest Labs:\n`);
      models.forEach((m) =>
        console.log(`  ${m.name.padEnd(35)} [${m.category}]  $${m.price_per_image}/MP (${m.display_name})`)
      );
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
