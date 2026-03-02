'use strict';

/**
 * Langdock model fetcher.
 *
 * Langdock's /v1/models API returns model IDs with no pricing.
 * Pricing lives at https://langdock.com/models — a Webflow SSR page.
 *
 * HTML structure (cheerio selectors):
 *   div.w-dyn-item                         → each model card
 *     div.models_row[fs-provider]          → row with provider attribute
 *       div.models_cell.is-model           → model name cell
 *         .text-size-small.text-weight-medium → model name text
 *       div.models_cell (2nd)              → input price cell
 *         p.text-size-small span:eq(1)     → price number
 *       div.models_cell (3rd)              → output price cell
 *         p.text-size-small span:eq(1)     → price number
 *
 * Pricing is in EUR with a stated 10% Langdock surcharge on provider rates.
 */

const cheerio = require('cheerio');
const { loadEnv } = require('../load-env');
loadEnv();

const MODELS_URL = 'https://langdock.com/models';

const parseEur = (text) => {
  if (!text) return null;
  const clean = text.trim();
  if (!clean || clean === '-' || clean === '–') return null;
  const m = clean.match(/([\d]+\.[\d]*|[\d]+)/);
  return m ? parseFloat(m[1]) : null;
};

const getSizeB = (name) => {
  const m = (name || '').match(/[^.\d](\d+)[Bb]/) || (name || '').match(/^(\d+)[Bb]/);
  return m ? parseInt(m[1]) : undefined;
};

async function fetchLangdock() {
  const response = await fetch(MODELS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} from ${MODELS_URL}`);
  const html = await response.text();
  const $ = cheerio.load(html);

  const models = [];
  const seen = new Set();

  $('div.w-dyn-item').each((_, item) => {
    const row = $(item).find('div.models_row').first();
    if (!row.length) return;

    const provider = row.attr('fs-provider') || '';
    const nameEl = row.find('div.models_cell.is-model .text-size-small').filter((_, el) => {
      // Pick the element with font-weight medium (model name), not the provider label
      return $(el).hasClass('text-weight-medium');
    }).first();

    if (!nameEl.length) return;
    const name = nameEl.text().trim();
    if (!name) return;

    const cells = row.find('div.models_cell').not('.is-model');

    // Input and output are the first two non-model cells that contain "/ 1M tokens"
    let inputPrice = null;
    let outputPrice = null;
    let priceCount = 0;

    cells.each((_, cell) => {
      const text = $(cell).text();
      if (!text.includes('1M tokens') && !text.includes('1M token')) return;
      const spans = $(cell).find('p.text-size-small span');
      // Spans: [currency_symbol, price_number, unit_string]
      const priceSpan = spans.eq(1);
      const val = parseEur(priceSpan.text());
      if (val === null) return;
      if (priceCount === 0) inputPrice = val;
      else if (priceCount === 1) outputPrice = val;
      priceCount++;
    });

    if (inputPrice === null) return;

    const key = `${provider}|${name}|${inputPrice}|${outputPrice}`;
    if (seen.has(key)) return;
    seen.add(key);

    const size_b = getSizeB(name);
    const model = {
      name,
      type: 'chat',
      input_price_per_1m: inputPrice,
      output_price_per_1m: outputPrice ?? 0,
      currency: 'EUR',
    };
    if (size_b) model.size_b = size_b;
    if (provider) model.provider_upstream = provider;

    models.push(model);
  });

  return models;
}

module.exports = { fetchLangdock, providerName: 'Langdock' };

if (require.main === module) {
  fetchLangdock()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Langdock:\n`);
      const byProvider = {};
      models.forEach((m) => {
        const p = m.provider_upstream || 'Unknown';
        (byProvider[p] = byProvider[p] || []).push(m);
      });
      for (const [prov, ms] of Object.entries(byProvider)) {
        console.log(`  [${prov}]`);
        ms.forEach((m) =>
          console.log(`    ${m.name.padEnd(40)} €${m.input_price_per_1m} / €${m.output_price_per_1m}`)
        );
      }
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
