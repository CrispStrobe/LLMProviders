'use strict';

/**
 * HostYourAI — EU Router (shared, pay-per-token) on European GPUs.
 * HostYourAI B.V., Netherlands. Open models served via vLLM from EU
 * datacentres; publishes a DPA and a sub-processor list, and offers an
 * "EU Sovereignty Mode" that restricts processing to EU-established
 * sub-processors.
 *
 * Only the EU Hosted Gateway (per-token) is represented here. HostYourAI also
 * sells dedicated GPU instances billed per hour and private deployments billed
 * per month; those are capacity rentals, not per-token inference, and the
 * schema has no unit for them — their tables are deliberately ignored.
 *
 * The per-model price tables are public HTML on the pricing page, so this
 * fetcher needs no API key and runs unattended in CI. (The OpenAI-compatible
 * /api/v1/models endpoint exists but is key-gated, and carries no pricing.)
 *
 * Tables are located by their header signature rather than by index, so the
 * fetcher survives re-ordering. The site is localised (nl/en/de) and serves
 * Dutch by default, so we request English and additionally accept the Dutch
 * and German column labels.
 *
 * Prices are EUR per 1M tokens, except the ASR table which is EUR per minute
 * of audio. Note the page also publishes a cached-input column; the data
 * schema has no cached-price field, so it is not carried through.
 *
 * Source: https://hostyourai.com/pricing  (verified 2026-09-11, 30 models)
 */

const cheerio = require('cheerio');
const { getText } = require('../fetch-utils');

const PRICING_URL = 'https://hostyourai.com/pricing';

const RE_INPUT = /input|invoer|eingabe/i;
const RE_OUTPUT = /output|uitvoer|ausgabe/i;
const RE_PER_MINUTE = /per minute|per minuut|pro minute/i;
const RE_CONTEXT = /context|kontext/i;
const RE_MODEL = /^(model|modell)$/i;

const VISION_KEYWORDS = [' vl', 'vl ', 'vision', 'pixtral', 'llava'];
const REASON_KEYWORDS = ['r1', 'thinking', 'reasoner', 'qwq'];

/**
 * Parse a European-or-Anglo formatted price: "0.23", "€ 0,0035", "1.234,56".
 * If both separators appear the last one is the decimal point; if only a comma
 * appears it is a decimal comma (these are all sub-unit prices, never
 * thousands).
 */
function parsePrice(text) {
  if (!text) return undefined;
  let s = String(text).replace(/[€$\s ]/g, '').trim();
  if (!s) return undefined;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

// "125K" -> 125000, "1M" -> 1000000, "40K" -> 40000
function parseContext(text) {
  const m = String(text || '').trim().match(/^([\d.,]+)\s*([KkMm])?$/);
  if (!m) return undefined;
  const n = parsePrice(m[1]);
  if (n == null) return undefined;
  const mult = m[2] ? (m[2].toLowerCase() === 'm' ? 1_000_000 : 1000) : 1;
  const v = Math.round(n * mult);
  return v > 0 ? v : undefined;
}

const getSizeB = (name) => {
  const match = (name || '').match(/(?:\b|-)(\d+(?:\.\d+)?)\s*[Bb](?:\b|-|:|$)/);
  if (!match) return undefined;
  const n = parseFloat(match[1]);
  return n > 0 && n < 2000 ? n : undefined;
};

function classify(name) {
  const s = ` ${(name || '').toLowerCase()} `;
  const caps = [];
  const isVision = VISION_KEYWORDS.some((k) => s.includes(k));
  if (isVision) caps.push('vision');
  if (REASON_KEYWORDS.some((k) => s.includes(k))) caps.push('reasoning');
  return { type: isVision ? 'vision' : 'chat', caps };
}

// Read a table as { headers: [...], rows: [[cell, ...], ...] }.
function readTable($, table) {
  const rows = [];
  let headers = [];
  $(table).find('tr').each((_, tr) => {
    const cells = $(tr).find('th, td').map((_, c) => $(c).text().trim()).get();
    if (!cells.length) return;
    const isHeader = $(tr).find('th').length > 0 && headers.length === 0;
    if (isHeader) headers = cells;
    else rows.push(cells);
  });
  return { headers, rows };
}

async function fetchHostyourai() {
  const html = await getText(PRICING_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const $ = cheerio.load(html);
  const models = [];
  const seen = new Set();

  $('table').each((_, table) => {
    const { headers, rows } = readTable($, table);
    if (!headers.length || !RE_MODEL.test(headers[0])) return; // GPU / config tables

    const iContext = headers.findIndex((h) => RE_CONTEXT.test(h));
    const iMinute = headers.findIndex((h) => RE_PER_MINUTE.test(h));
    // The cached-input column also matches RE_INPUT in some locales, so take
    // the first input-ish column and the last output-ish one.
    const iInput = headers.findIndex((h) => RE_INPUT.test(h));
    const iOutput = headers.map((h) => RE_OUTPUT.test(h)).lastIndexOf(true);

    for (const cells of rows) {
      const name = (cells[0] || '').trim();
      if (!name || seen.has(name)) continue;

      const entry = { name, currency: 'EUR' };
      const context = iContext >= 0 ? parseContext(cells[iContext]) : undefined;

      if (iMinute >= 0) {
        // Speech-to-text: billed per minute of audio, not per token.
        const perMin = parsePrice(cells[iMinute]);
        if (perMin == null) continue;
        entry.type = 'audio';
        entry.price_per_minute = perMin;
        entry.capabilities = ['audio'];
      } else if (iInput >= 0) {
        const input = parsePrice(cells[iInput]);
        if (input == null) continue;
        const output = iOutput >= 0 && iOutput !== iInput ? parsePrice(cells[iOutput]) : undefined;
        if (output == null) {
          // Input-only pricing is how the embedding table is shaped.
          entry.type = 'embedding';
          entry.input_price_per_1m = input;
          entry.output_price_per_1m = 0;
        } else {
          const { type, caps } = classify(name);
          entry.type = type;
          entry.input_price_per_1m = input;
          entry.output_price_per_1m = output;
          if (caps.length) entry.capabilities = caps;
        }
      } else {
        continue;
      }

      if (context) entry.context_window = context;
      const size_b = getSizeB(name);
      if (size_b) entry.size_b = size_b;

      seen.add(name);
      models.push(entry);
    }
  });

  if (models.length === 0) {
    throw new Error('No models parsed from HostYourAI pricing page (structure changed?)');
  }

  models.sort((a, b) => (a.input_price_per_1m ?? 0) - (b.input_price_per_1m ?? 0));
  return models;
}

module.exports = { fetchHostyourai, providerName: 'HostYourAI' };

// Run standalone: node scripts/providers/hostyourai.js
if (require.main === module) {
  fetchHostyourai()
    .then((models) => {
      console.log(`Fetched ${models.length} models from HostYourAI\n`);
      models.forEach((m) =>
        console.log(
          `  ${m.name.padEnd(30)} ${m.type.padEnd(10)} ` +
            (m.price_per_minute != null
              ? `€${m.price_per_minute}/min`
              : `€${m.input_price_per_1m} / €${m.output_price_per_1m}`) +
            (m.context_window ? `   ctx ${m.context_window}` : '')
        )
      );
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
