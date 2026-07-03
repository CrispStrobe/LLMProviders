'use strict';

/**
 * STACKIT AI Model Serving — German sovereign cloud (Schwarz Group), Germany.
 * OpenAI-compatible, pay-per-token. Requires a STACKIT account/project to call.
 *
 * The model catalog is scraped from the public docs "available shared models"
 * page (static HTML): each model is an <h3> name followed, in document order,
 * by its Hugging Face model-card link and a detail table carrying the pricing
 * Category (LLM-Premium / LLM-Plus / LLM-Standard / Embedding-*), the model
 * Type, Modalities, Features and parameter count.
 *
 * Per-token prices are NOT on that page — they live in the official price list
 * and are keyed by Category, so we map Category -> price here. Update CATEGORY_
 * PRICING when STACKIT revises the price list.
 *
 * Sources:
 *   Catalog: https://docs.stackit.cloud/products/data-and-ai/ai-model-serving/basics/available-shared-models/
 *   Prices:  https://stackit.com/en/asset/download/37788/file/STACKIT_price_list.pdf  (verified 2026-07-03)
 */

const cheerio = require('cheerio');
const { getText } = require('../fetch-utils');

const DOCS_URL =
  'https://docs.stackit.cloud/products/data-and-ai/ai-model-serving/basics/available-shared-models/';

// EUR per 1M tokens, keyed by the docs "Category" field. Embeddings bill input only.
const CATEGORY_PRICING = {
  'llm-premium': { input: 1.5, output: 1.75 },
  'llm-plus': { input: 0.45, output: 0.65 },
  'llm-standard': { input: 0.15, output: 0.25 },
  'embedding-standard': { input: 0.02, output: 0 },
  'embedding-plus': { input: 0.08, output: 0 },
};

const parseParamsB = (text) => {
  // "70.6 Billion in 8 bit quantization" -> 70.6 ; "235 Billion ..." -> 235
  const m = (text || '').match(/([\d.]+)\s*Billion/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return n > 0 && n < 2000 ? n : undefined;
};

// Read a labelled row's value from a detail table.
const rowValue = ($, table, labelRe) => {
  let val = null;
  $(table).find('tr').each((_, r) => {
    const cells = $(r).find('td, th').map((_, x) => $(x).text().trim()).get();
    if (cells[0] && labelRe.test(cells[0])) val = cells.slice(1).join(' ').trim();
  });
  return val;
};

const isModelCardLink = (href) =>
  /^https?:\/\/huggingface\.co\/[^/]+\/[^/]+$/.test(href || '');

function buildModel(name, hfId, table, $) {
  const category = (rowValue($, table, /^category$/i) || '').trim();
  const catKey = category.toLowerCase();
  const pricing = CATEGORY_PRICING[catKey];
  if (!pricing) {
    console.warn(`  ⚠ STACKIT: unknown pricing category "${category}" for ${name} — skipping`);
    return null;
  }

  const declaredType = (rowValue($, table, /^type$/i) || '').toLowerCase();
  const modalities = (rowValue($, table, /modalities/i) || '').toLowerCase();
  const features = (rowValue($, table, /features/i) || '').toLowerCase();
  const paramsText = rowValue($, table, /parameters/i);

  const hasImageIn = /image/.test(modalities);
  let type;
  if (declaredType.includes('embedding')) type = 'embedding';
  else if (hasImageIn) type = 'vision';
  else type = 'chat';

  const capabilities = [];
  if (hasImageIn) capabilities.push('vision');
  if (/tool calling/.test(features)) capabilities.push('tools');
  if (/reasoning/.test(features)) capabilities.push('reasoning');

  const model = {
    name,
    type,
    currency: 'EUR',
    input_price_per_1m: pricing.input,
    output_price_per_1m: pricing.output,
  };
  if (capabilities.length) model.capabilities = capabilities;
  if (hfId) model.hf_id = hfId;

  const size_b = parseParamsB(paramsText);
  if (size_b) model.size_b = size_b;

  return model;
}

async function fetchStackit() {
  const html = await getText(DOCS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const $ = cheerio.load(html);
  const models = [];

  // Walk headings, model-card links and tables in document order. Each model is
  // an <h3> name, then its HF model-card link, then a detail table (with a
  // Category row). A model is emitted when its category table is reached.
  let currentName = null;
  let currentHfId = null;
  $('h3, a[href*="huggingface.co"], table').each((_, el) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'h3') {
      currentName = $(el).text().trim();
      currentHfId = null;
      return;
    }
    if (tag === 'a') {
      const href = $(el).attr('href');
      if (!currentHfId && isModelCardLink(href)) {
        currentHfId = href.replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/+$/, '');
      }
      return;
    }
    // table
    if (!currentName) return;
    if (!rowValue($, el, /^category$/i)) return; // not a model detail table
    const model = buildModel(currentName, currentHfId, el, $);
    if (model) models.push(model);
    currentName = null; // consumed
    currentHfId = null;
  });

  if (models.length === 0) {
    throw new Error('No models parsed from STACKIT docs (page structure changed?)');
  }

  return models;
}

module.exports = { fetchStackit, providerName: 'STACKIT' };

// Run standalone: node scripts/providers/stackit.js
if (require.main === module) {
  fetchStackit()
    .then((models) => {
      console.log(`Fetched ${models.length} models from STACKIT:\n`);
      models.forEach((m) =>
        console.log(
          `  ${m.name.padEnd(34)} ${m.type.padEnd(10)} €${m.input_price_per_1m} / €${m.output_price_per_1m}` +
            (m.hf_id ? `   ${m.hf_id}` : '')
        )
      );
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
