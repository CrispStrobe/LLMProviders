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
 *
 * Since 2026-11 the page is an Astro build: each model is a serialized island
 * prop ({"slug":[0,"…"],"name":[0,"…"],"provider":[0,"…"],…,
 * "inputPriceEur":[0,N],"outputPriceEur":[0,N],"details":[0,{"contextWindow":…}]})
 * inside an HTML-escaped attribute. parseAstroModels() reads that; the Webflow
 * card parser below remains as a fallback.
 */

const cheerio = require('cheerio');
const { loadEnv } = require('../load-env');
const { getText } = require('../fetch-utils');
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

const decodeEntities = (text) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const ASTRO_MODEL = /\{"slug":\[0,"([^"]+)"\],"name":\[0,"([^"]+)"\],"provider":\[0,"([^"]*)"\].*?"inputPriceEur":\[0,(null|[-\d.eE]+)\],"outputPriceEur":\[0,(null|[-\d.eE]+)\](?:,"details":\[0,\{"contextWindow":\[0,(\d+)\])?/g;

function parseAstroModels(html) {
  const text = decodeEntities(html);
  const models = [];
  const seen = new Set();
  for (const m of text.matchAll(ASTRO_MODEL)) {
    const [, slug, name, provider, input, output, context] = m;
    if (input === 'null' || seen.has(slug)) continue;
    seen.add(slug);
    const model = {
      name,
      type: 'chat',
      input_price_per_1m: parseFloat(input),
      output_price_per_1m: output === 'null' ? 0 : parseFloat(output),
      currency: 'EUR',
    };
    const size_b = getSizeB(name);
    if (size_b) model.size_b = size_b;
    if (context) model.context_window = parseInt(context, 10);
    if (provider) model.provider_upstream = provider;
    models.push(model);
  }
  return models;
}

async function fetchLangdock() {
  const html = await getText(MODELS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const astro = parseAstroModels(html);
  if (astro.length) return astro;

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

module.exports = { fetchLangdock, parseAstroModels, providerName: 'Langdock' };

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
