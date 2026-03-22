'use strict';

/**
 * Infomaniak AI pricing fetcher.
 *
 * Source: https://www.infomaniak.com/en/hosting/ai-services/prices
 * The page is a 2.5MB SSR bundle (no Next.js, no __NEXT_DATA__).
 * Pricing data is embedded in the HTML using CSS-module class names.
 *
 * Structure per model card:
 *   div[class*="sectionWrapperPricesContentModelsTitle"]
 *     p[class*="IkTypography-module--h4"]  → model name
 *   div[class*="sectionWrapperPricesContentModelsPrice"]
 *     div[class*="sectionWrapperPricesContentModelsPriceWrapper"] (×2)
 *       p  → "Incoming token:" or "Outgoing token:" (or "Image:")
 *       span[class*="IkTypography-module--h3"]  → price number
 *       span[class*="color-text-secondary"]      → currency (CHF)
 *
 * Currency is CHF (Swiss Francs).
 */

const cheerio = require('cheerio');
const { getText } = require('../fetch-utils');

const URL = 'https://www.infomaniak.com/en/hosting/ai-services/prices';

const parsePrice = (text) => {
  if (!text) return null;
  if (text.trim().toLowerCase() === 'free' || text.trim().toLowerCase() === 'gratuit') return 0;
  const m = text.trim().match(/([\d]+\.[\d]*|[\d]+)/);
  return m ? parseFloat(m[1]) : null;
};

const getSizeB = (name) => {
  const m = (name || '').match(/[^.\d](\d+)[Bb]/) || (name || '').match(/^(\d+)[Bb]/);
  return m ? parseInt(m[1]) : undefined;
};

const inferType = (name) => {
  const n = name.toLowerCase();
  if (n.includes('embed') || n.includes('minilm') || n.includes('bge')) return 'embedding';
  if (n.includes('whisper')) return 'audio';
  if (n.includes('flux') || n.includes('photomaker') || n.includes('image')) return 'image';
  return 'chat';
};

async function fetchInfomaniak() {
  const html = await getText(URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'STATIC_CURRENCY=EUR; locale=en_US',
    },
  });
  const $ = cheerio.load(html);

  const models = [];

  // Each model card contains a "Title" div (name) followed by a "Price" div (pricing rows)
  // Use the CSS-module partial class pattern for both
  $('[class*="sectionWrapperPricesContentModelsTitle"]').each((_, titleEl) => {
    const nameEl = $(titleEl).find('[class*="IkTypography-module--h4"]').first();
    if (!nameEl.length) return;

    // Strip provider prefix (e.g. "openai/gpt-oss-120b" → "gpt-oss-120b")
    const rawName = nameEl.text().trim();
    const name = rawName.includes('/') ? rawName.split('/').pop() : rawName;
    if (!name) return;

    // The price section is the direct next sibling of the title div
    const priceSection = $(titleEl).next('[class*="sectionWrapperPricesContentModelsPrice"]');
    if (!priceSection.length) return;

    let inputPrice = null;
    let outputPrice = null;
    let currency = 'CHF';

    priceSection.find('[class*="sectionWrapperPricesContentModelsPriceWrapper"]').each((_, priceRow) => {
      const label = $(priceRow).find('p').first().text().toLowerCase();
      // Currency from the secondary span
      const currSpan = $(priceRow).find('[class*="color-text-secondary"]').first();
      const currText = currSpan.text().trim().replace(/\s/g, '');
      if (currText && /^[A-Z]{3}$/.test(currText)) currency = currText;

      const valSpan = $(priceRow).find('[class*="IkTypography-module--h3"]').first();
      const val = parsePrice(valSpan.text());
      if (val === null) return;

      if (label.includes('entrant') || label.includes('incoming') || label.includes('input')) {
        inputPrice = val;
      } else if (label.includes('sortant') || label.includes('outgoing') || label.includes('output')) {
        outputPrice = val;
      } else if (label.includes('image') || label.includes('per image')) {
        inputPrice = val; // image models: price per image stored as input
      } else if (inputPrice === null) {
        inputPrice = val; // fallback: first price row = input
      }
    });

    if (inputPrice === null) return;

    const type = inferType(name);
    const size_b = getSizeB(name);

    const model = {
      name,
      type,
      currency,
    };

    if (type === 'audio') {
      model.price_per_minute = inputPrice;
    } else {
      model.input_price_per_1m = inputPrice;
      model.output_price_per_1m = outputPrice ?? 0;
    }

    if (size_b) model.size_b = size_b;

    models.push(model);
  });

  return models;
}

module.exports = { fetchInfomaniak, providerName: 'Infomaniak' };

if (require.main === module) {
  fetchInfomaniak()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Infomaniak:\n`);
      const byType = {};
      models.forEach((m) => { (byType[m.type] = byType[m.type] || []).push(m); });
      for (const [type, ms] of Object.entries(byType)) {
        console.log(`  [${type}]`);
        ms.forEach((m) =>
          console.log(`    ${m.name.padEnd(45)} ${m.currency} ${m.input_price_per_1m} / ${m.output_price_per_1m}`)
        );
      }
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
