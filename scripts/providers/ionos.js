'use strict';

/**
 * IONOS AI Model Hub pricing fetcher.
 *
 * Source: https://cloud.ionos.com/managed/ai-model-hub
 * The page is SSR'd (Next.js pages router with Tailwind CSS classes).
 * Pricing is embedded in real <table> elements — cheerio works fine.
 *
 * Tables on the page (desktop versions are even-indexed):
 *   0. LLM / chat  — cols: tier | model(s) | input $/M tok | output $/M tok
 *                    The model cell can list several models separated by \n
 *   2. OCR / vision — cols: model | input $/M tok | output $/M tok
 *   4. Image        — cols: model | price per image
 *   6. Embedding    — cols: model | price per 1M tokens
 *   8. Storage      — skip
 * Odd-indexed tables (1,3,5,7,9) are mobile card duplicates of the above.
 */

const cheerio = require('cheerio');
const { getText } = require('../fetch-utils');

const URL = 'https://cloud.ionos.com/managed/ai-model-hub';

const parseUsd = (text) => {
  if (!text) return null;
  const m = text.trim().match(/\$?([\d]+\.[\d]*|[\d]+)/);
  return m ? parseFloat(m[1]) : null;
};

const getSizeB = (name) => {
  const m = (name || '').match(/[^.\d](\d+)[Bb]/) || (name || '').match(/^(\d+)[Bb]/);
  return m ? parseInt(m[1]) : undefined;
};

// Split a cell value that may contain multiple model names separated by newlines
const splitModels = (text) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

async function fetchIonos() {
  const html = await getText(URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const $ = cheerio.load(html);

  const models = [];
  const tables = $('table').toArray();

  // ── Table 0: LLM / chat ─────────────────────────────────────────────────────
  // cols: tier (may be empty for continuation rows) | model(s) | input | output
  const llmTable = $(tables[0]);
  llmTable.find('tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    const rawNames = cells.eq(1).text();
    const inputPrice = parseUsd(cells.eq(2).text());
    const outputPrice = parseUsd(cells.eq(3).text());
    if (inputPrice === null) return;

    splitModels(rawNames).forEach((name) => {
      if (!name) return;
      const model = {
        name,
        type: 'chat',
        input_price_per_1m: inputPrice,
        output_price_per_1m: outputPrice ?? 0,
        currency: 'USD',
      };
      const size_b = getSizeB(name);
      if (size_b) model.size_b = size_b;
      models.push(model);
    });
  });

  // ── Table 2: OCR / vision ───────────────────────────────────────────────────
  // cols: model | input | output
  const ocrTable = $(tables[2]);
  ocrTable.find('tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;
    const name = cells.eq(0).text().trim();
    const inputPrice = parseUsd(cells.eq(1).text());
    const outputPrice = parseUsd(cells.eq(2).text());
    if (!name || inputPrice === null) return;
    models.push({
      name,
      type: 'vision',
      capabilities: ['vision', 'files'],
      input_price_per_1m: inputPrice,
      output_price_per_1m: outputPrice ?? 0,
      currency: 'USD',
    });
  });

  // ── Table 4: Image generation ───────────────────────────────────────────────
  // cols: model | price per image
  const imgTable = $(tables[4]);
  imgTable.find('tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    // Strip badge text like " New" appended after the model name
    const name = cells.eq(0).text().trim().replace(/\s+New$/, '');
    const pricePerImage = parseUsd(cells.eq(1).text());
    if (!name || pricePerImage === null) return;
    models.push({
      name,
      type: 'image',
      input_price_per_1m: pricePerImage,
      output_price_per_1m: 0,
      currency: 'USD',
    });
  });

  // ── Table 6: Embedding ───────────────────────────────────────────────────────
  // cols: model | price per 1M tokens
  const embTable = $(tables[6]);
  embTable.find('tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const name = cells.eq(0).text().trim();
    const inputPrice = parseUsd(cells.eq(1).text());
    if (!name || inputPrice === null) return;
    models.push({
      name,
      type: 'embedding',
      input_price_per_1m: inputPrice,
      output_price_per_1m: 0,
      currency: 'USD',
    });
  });

  return models;
}

module.exports = { fetchIonos, providerName: 'IONOS' };

if (require.main === module) {
  fetchIonos()
    .then((models) => {
      console.log(`Fetched ${models.length} models from IONOS:\n`);
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
