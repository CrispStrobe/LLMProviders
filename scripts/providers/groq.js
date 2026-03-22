'use strict';

/**
 * Groq pricing fetcher.
 *
 * groq.com/pricing is a Next.js App Router page (RSC streaming) with real
 * <table class="type-ui-1"> elements rendered server-side — cheerio works.
 *
 * Tables on the page:
 *   1. Large Language Models  → chat models, cols: name / speed / input ($/M tok) / output ($/M tok)
 *   2. Text-to-Speech         → audio, cols: name / chars/s / price ($/M chars)
 *   3. ASR (Whisper)          → audio, cols: name / speed / price ($/hr transcribed)
 *   4-6. Caching / Tools      → skip
 */

const cheerio = require('cheerio');
const { getText } = require('../fetch-utils');

const URL = 'https://groq.com/pricing';

const parseUsd = (text) => {
  if (!text) return null;
  const clean = text.trim();
  if (!clean || clean === '-' || clean === '–') return null;
  const m = clean.match(/\$?([\d]+\.[\d]*|[\d]+)/);
  return m ? parseFloat(m[1]) : null;
};

const getSizeB = (name) => {
  const m = (name || '').match(/[^.\d](\d+)[Bb]/) || (name || '').match(/^(\d+)[Bb]/);
  return m ? parseInt(m[1]) : undefined;
};

// Extract the first meaningful span text from a td cell
// Groq wraps content in: td > div > div[class*=contents-inner] > span
const cellText = ($, cell) => {
  // Try the inner contents div first, fall back to any span
  const inner = $(cell).find('[class*="contents-inner"] span').first();
  if (inner.length) return inner.text().trim();
  return $(cell).find('span').first().text().trim();
};

async function fetchGroq() {
  const html = await getText(URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const $ = cheerio.load(html);

  const models = [];

  $('table').each((_, table) => {
    // Find the nearest preceding heading to determine section type
    let sectionTitle = '';
    let prev = $(table).parent();
    for (let depth = 0; depth < 8; depth++) {
      const h = prev.find('h1, h2, h3, h4').last();
      if (h.length) { sectionTitle = h.text().trim(); break; }
      const prevSibling = prev.prev();
      const hSibling = prevSibling.is('h1,h2,h3,h4')
        ? prevSibling
        : prevSibling.find('h1,h2,h3,h4').last();
      if (hSibling.length) { sectionTitle = hSibling.text().trim(); break; }
      prev = prev.parent();
    }

    const titleLower = sectionTitle.toLowerCase();

    // Skip non-pricing tables
    if (titleLower.includes('caching') || titleLower.includes('tool') || titleLower.includes('compound')) return;

    // Determine model type from section title
    let tableType = 'chat';
    if (titleLower.includes('speech') && titleLower.includes('text')) tableType = 'audio'; // TTS
    if (titleLower.includes('recognition') || titleLower.includes('asr') || titleLower.includes('whisper')) tableType = 'audio';

    // Parse header row to find column indices
    const headers = [];
    $(table).find('thead th').each((_, th) => {
      headers.push($(th).text().toLowerCase().replace(/\s+/g, ' ').trim());
    });

    const colIdx = (...keywords) =>
      headers.findIndex((h) => keywords.some((k) => h.includes(k)));

    const nameCol = colIdx('model', 'name') ?? 0;
    const inputCol = colIdx('input token', 'input price');
    const outputCol = colIdx('output token', 'output price');
    // For TTS/ASR: single price column
    const priceCol = colIdx('per m char', 'per hour', 'price');

    $(table).find('tbody tr').each((_, row) => {
      const cells = $(row).find('td').toArray();
      if (cells.length < 2) return;

      const name = cellText($, cells[nameCol >= 0 ? nameCol : 0]);
      if (!name) return;

      let inputPrice = null;
      let outputPrice = null;

      if (inputCol >= 0 && outputCol >= 0) {
        // LLM table
        inputPrice = parseUsd(cellText($, cells[inputCol]));
        outputPrice = parseUsd(cellText($, cells[outputCol]));
      } else if (priceCol >= 0) {
        // TTS or ASR — single price column
        inputPrice = parseUsd(cellText($, cells[priceCol]));
        outputPrice = 0;
      }

      if (inputPrice === null) return;

      const size_b = getSizeB(name);
      const caps = [];
      if (tableType === 'audio') caps.push('audio');
      if (name.toLowerCase().includes('voxtral')) caps.push('tools');

      const model = {
        name,
        type: tableType,
        currency: 'USD',
      };

      if (caps.length) model.capabilities = caps;

      if (tableType === 'audio') {
        const headerText = headers[priceCol] || '';
        if (headerText.includes('hour')) {
          model.price_per_minute = inputPrice / 60;
        } else {
          // TTS: per M characters
          model.input_price_per_1m = inputPrice;
          model.output_price_per_1m = 0;
        }
      } else {
        model.input_price_per_1m = inputPrice;
        model.output_price_per_1m = outputPrice ?? 0;
      }

      if (size_b) model.size_b = size_b;

      models.push(model);
    });
  });

  return models;
}

module.exports = { fetchGroq, providerName: 'Groq' };

if (require.main === module) {
  fetchGroq()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Groq:\n`);
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
