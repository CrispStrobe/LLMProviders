'use strict';

/**
 * Mistral AI pricing fetcher.
 *
 * As of 2026 mistral.ai re-platformed onto Astro and moved API pricing to
 * /pricing/api/ (the old /pricing now shows Le Chat subscription plans, and the
 * previous Next.js RSC "apis" payload is gone). On the new page each model is a
 * card:
 *
 *   <p class="text-h5 font-mistral">Mistral Medium 3.5</p>
 *   ...
 *   <p>Input (/M tokens)</p>  <mistral-atom-text-price data-prices='{"priceUsd":1.5,...}'>
 *   <p>Output (/M tokens)</p> <mistral-atom-text-price data-prices='{"priceUsd":7.5,...}'>
 *
 * We walk the model-name headings and price atoms in document order, reading the
 * USD price out of each atom's data-prices JSON and the unit from its row label.
 */

const cheerio = require('cheerio');
const { getText } = require('../fetch-utils');

const URL = 'https://docs.mistral.ai/inference/pricing';

const getSizeB = (name) => {
  const match = (name || '').match(/[^.\d](\d+)[Bb]/) || (name || '').match(/^(\d+)[Bb]/);
  return match ? parseInt(match[1]) : undefined;
};

const getModelType = (name) => {
  const n = (name || '').toLowerCase();
  if (n.includes('voxtral')) return 'audio';
  if (n.includes('embed')) return 'embedding';
  return 'chat';
};

const priceUsd = ($, atom) => {
  try {
    const d = JSON.parse($(atom).attr('data-prices') || '{}');
    return typeof d.priceUsd === 'number' ? d.priceUsd : null;
  } catch {
    return null;
  }
};

async function fetchMistral() {
  const html = await getText(URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (html.includes('cf-browser-verification') || html.includes('Just a moment')) {
    throw new Error('Blocked by Cloudflare');
  }

  const $ = cheerio.load(html);

  // Current docs.mistral.ai layout: one table per model family with the
  // columns Model | Input | Cached input | Output, plus featured cards
  // (h3 + <dl>) for a few models. Read both; tables win on duplicates.
  const acc = new Map();
  const num = (s) => {
    const m = (s || '').match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
    return m ? parseFloat(m[1]) : null;
  };

  $('table').each((_, table) => {
    const headers = $(table).find('thead th').map((__, th) => $(th).text().trim().toLowerCase()).get();
    if (!headers.length) return;
    const iName = headers.findIndex((h) => h.includes('model'));
    const iIn = headers.findIndex((h) => h.includes('input') && !h.includes('cached'));
    const iCache = headers.findIndex((h) => h.includes('cached'));
    const iOut = headers.findIndex((h) => h.includes('output'));
    if (iName < 0 || (iIn < 0 && iOut < 0)) return;

    $(table).find('tbody tr').each((__, tr) => {
      const cells = $(tr).find('td');
      if (!cells.length) return;
      const name = cells.eq(iName).text().replace(/↗/g, '').trim();
      if (!name) return;
      const input = iIn >= 0 ? num(cells.eq(iIn).text()) : null;
      const output = iOut >= 0 ? num(cells.eq(iOut).text()) : null;
      const cached = iCache >= 0 ? num(cells.eq(iCache).text()) : null;
      if (input == null && output == null) return;
      acc.set(name, { name, input, output, cached });
    });
  });

  // Featured cards: <h3>Model</h3> followed by <dt>Input</dt><dd>$0.7 /M Tokens</dd>.
  $('h3').each((_, h) => {
    const name = $(h).text().trim();
    if (!name || acc.has(name)) return;
    const dl = $(h).parent().find('dl').first();
    if (!dl.length) return;

    const entry = { name };
    dl.find('div').each((__, row) => {
      const label = $(row).find('dt').first().text().trim().toLowerCase();
      const valText = $(row).find('dd').first().text().trim();
      const val = num(valText);
      if (val === null) return;
      const perMillion = /\/\s*m|tokens/i.test(valText);
      if (label.startsWith('input') && perMillion) entry.input = val;
      else if (label.startsWith('output') && perMillion) entry.output = val;
      else if (label.includes('min')) entry.perMin = val;
    });

    if (entry.input != null || entry.output != null || entry.perMin != null) {
      acc.set(name, entry);
    }
  });

  const models = [];
  for (const m of acc.values()) {
    // Only emit rows we could price as a model (token or per-minute). This drops
    // Agent-API feature rows (per-call / per-1K-images) and free entries.
    if (m.input == null && m.output == null && m.perMin == null) continue;

    const type = getModelType(m.name);
    const caps = [];
    if (type === 'audio') caps.push('audio');
    if (/magistral/i.test(m.name)) caps.push('reasoning');

    const model = { name: m.name, type, currency: 'USD' };
    if (caps.length) model.capabilities = caps;

    if (m.perMin != null) model.price_per_minute = m.perMin;
    if (m.input != null) model.input_price_per_1m = m.input;
    if (m.output != null) model.output_price_per_1m = m.output;
    // Chat/embedding models should always expose an output field for the UI.
    if (type !== 'audio' && model.input_price_per_1m != null && model.output_price_per_1m == null) {
      model.output_price_per_1m = 0;
    }

    const size_b = getSizeB(m.name);
    if (size_b) model.size_b = size_b;

    models.push(model);
  }

  if (models.length === 0) {
    throw new Error('No priced models parsed from Mistral pricing page (structure changed?)');
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
        ms.forEach((m) => {
          let priceStr = '';
          if (m.price_per_minute !== undefined) priceStr += `$${m.price_per_minute}/min `;
          if (m.input_price_per_1m !== undefined || m.output_price_per_1m !== undefined) {
            priceStr += `$${m.input_price_per_1m ?? 0} / $${m.output_price_per_1m ?? 0}`;
          }
          console.log(`    ${m.name.padEnd(40)} ${priceStr.trim()}`);
        });
      }
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
