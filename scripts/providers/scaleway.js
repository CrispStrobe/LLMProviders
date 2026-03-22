'use strict';

const cheerio = require('cheerio');
const { getText } = require('../fetch-utils');

const URL = 'https://www.scaleway.com/en/pricing/model-as-a-service/';

const parseEurPrice = (text) => {
  if (!text) return null;
  const clean = text.trim();
  if (clean.toLowerCase() === 'free' || clean === '') return 0;
  // Match €0.75 or just 0.75
  const match = clean.match(/€?([\d]+\.[\d]+|[\d]+)/);
  return match ? parseFloat(match[1]) : null;
};

const getModelType = (tasks) => {
  const t = (tasks || '').toLowerCase();
  if (t.includes('embed')) return 'embedding';
  if (t.includes('audio transcription')) return 'audio';
  if (t.includes('audio') && !t.includes('chat')) return 'audio';
  return 'chat';
};

const getSizeB = (name) => {
  // Match patterns like 1.2b, 70b, 8b. Support decimals.
  const match = (name || '').match(/(?:\b|-)([\d.]+)[Bb](?:\b|:|$)/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  return (num > 0 && num < 2000) ? num : undefined;
};

async function fetchScaleway() {
  const html = await getText(URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
  });

  // Quick sanity check for Cloudflare block
  if (html.includes('cf-browser-verification') || html.includes('Just a moment')) {
    throw new Error('Blocked by Cloudflare – try adding a delay or using a browser-based fetcher');
  }

  const $ = cheerio.load(html);
  const models = [];

  // Find all tables and pick the pricing one
  $('table').each((_tableIdx, table) => {
    const headerTexts = [];
    $(table).find('thead th, thead td').each((_, th) => {
      headerTexts.push($(th).text().trim().toLowerCase());
    });

    // Must look like a model pricing table
    const hasModel = headerTexts.some(h => h.includes('model') || h.includes('name'));
    const hasPrice = headerTexts.some(h => h.includes('input') || h.includes('price'));
    if (!hasModel && !hasPrice) return;

    // Resolve column indices with fallbacks
    const colIdx = (keywords) => {
      const idx = headerTexts.findIndex(h => keywords.some(k => h.includes(k)));
      return idx >= 0 ? idx : null;
    };

    const modelCol = colIdx(['model', 'name']) ?? 0;
    const taskCol = colIdx(['task', 'type', 'capabilit']);
    const inputCol = colIdx(['input']) ?? 2;
    const outputCol = colIdx(['output']) ?? 3;

    $(table).find('tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const name = $(cells[modelCol]).text().trim();
      const tasks = taskCol != null ? $(cells[taskCol]).text().trim() : '';
      const inputText = $(cells[inputCol]).text().trim();
      const outputText = outputCol < cells.length ? $(cells[outputCol]).text().trim() : '';

      if (!name) return;

      // Skip GPU/compute instance rows (e.g. L4-1-24G, H100-SXM-4-80G, L40S-1-48G)
      if (/^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+-\d+G$/i.test(name)) return;

      const inputPrice = parseEurPrice(inputText);
      const outputPrice = parseEurPrice(outputText);

      // Skip rows we couldn't parse a price for
      if (inputPrice === null) return;

      const type = getModelType(tasks || name);
      const size_b = getSizeB(name);

      const model = {
        name,
        type,
        currency: 'EUR',
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
  });

  // Fallback: if table parsing yielded nothing, try regex on the raw HTML
  if (models.length === 0) {
    console.warn('  Table parser found nothing – falling back to text extraction');
    const rows = html.matchAll(
      /([a-z0-9][a-z0-9\-\.]+(?:instruct|embed|whisper|voxtral|gemma|llama|mistral|qwen|pixtral|devstral|holo|bge)[a-z0-9\-\.]*)\D+€([\d.]+)\D+€([\d.]+)/gi
    );
    for (const m of rows) {
      const name = m[1];
      const size_b = getSizeB(name);
      const model = {
        name,
        type: 'chat',
        input_price_per_1m: parseFloat(m[2]),
        output_price_per_1m: parseFloat(m[3]),
        currency: 'EUR',
      };
      if (size_b) model.size_b = size_b;
      models.push(model);
    }
  }

  return models;
}

module.exports = { fetchScaleway, providerName: 'Scaleway' };

// Run standalone: node scripts/providers/scaleway.js
if (require.main === module) {
  fetchScaleway()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Scaleway:\n`);
      models.forEach((m) =>
        console.log(`  ${m.name.padEnd(50)} €${m.input_price_per_1m} / €${m.output_price_per_1m}`)
      );
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
