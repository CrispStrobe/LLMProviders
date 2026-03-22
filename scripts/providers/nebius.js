'use strict';

/**
 * Nebius Token Factory pricing fetcher.
 *
 * The pricing page (nebius.com/token-factory/prices) is a Next.js SSR app.
 * Pricing tables live inside __NEXT_DATA__ -> __APOLLO_STATE__ -> page content
 * which is a *double-encoded* JSON string. We parse it twice.
 *
 * Table types found on the page:
 *   ['Model','Flavor','Input','Output']  – text-to-text; pairs of rows (fast/base)
 *   ['Model','Input','Output']           – vision / guardrails; single rows
 *   ['Model','Input']                    – image gen / embeddings; single rows
 */

const { getText } = require('../fetch-utils');

const URL = 'https://nebius.com/token-factory/prices';

const parseUsd = (text) => {
  if (!text) return null;
  const clean = text.trim();
  if (clean === '–' || clean === '-' || clean === '' || clean.toLowerCase() === 'free') return 0;
  const match = clean.match(/\$?([\d]+\.[\d]*|[\d]+)/);
  return match ? parseFloat(match[1]) : null;
};

const getSizeB = (name) => {
  const match = (name || '').match(/[^.\d](\d+)[Bb]/) || (name || '').match(/^(\d+)[Bb]/);
  return match ? parseInt(match[1]) : undefined;
};

// Recursively walk a parsed JSON object and collect all table.content arrays.
// Returns [{ type, rows }] where type is inferred from surrounding block context.
function collectTables(obj, context = {}) {
  const results = [];
  if (!obj || typeof obj !== 'object') return results;

  if (Array.isArray(obj)) {
    for (const item of obj) results.push(...collectTables(item, context));
    return results;
  }

  // Pick up section context from block type/title
  const blockType = obj.type || '';
  const newCtx = { ...context };
  if (obj.title) newCtx.title = obj.title;
  if (blockType.includes('tabs')) newCtx.inTabs = true;

  // Found a table
  if (obj.table && Array.isArray(obj.table.content)) {
    results.push({ context: newCtx, rows: obj.table.content });
  }

  // Also capture the description near a table to infer section type
  if (obj.description && typeof obj.description === 'string') {
    newCtx.description = obj.description;
  }

  for (const val of Object.values(obj)) {
    results.push(...collectTables(val, newCtx));
  }
  return results;
}

function modelsFromTable({ rows }) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map((h) => (h || '').toLowerCase());
  const hasFlavor = header.includes('flavor') || header.includes('tier');
  const hasOutput = header.includes('output');

  const modelCol = header.indexOf('model') >= 0 ? header.indexOf('model') : 0;
  const flavorCol = hasFlavor ? header.indexOf('flavor') : -1;
  const inputCol = header.indexOf('input') >= 0 ? header.indexOf('input') : (hasFlavor ? 2 : 1);
  const outputCol = hasOutput ? header.indexOf('output') : -1;

  // Infer model type from header columns
  let type = 'chat';
  const headerStr = header.join(' ');
  if (!hasOutput && !hasFlavor) {
    // image gen or embedding — single input price column
    type = 'image'; // will be overridden by section context below
  }

  const models = [];
  let lastModelName = '';

  for (const row of rows.slice(1)) {
    const rawName = (row[modelCol] || '').trim();
    // Carry forward the name when the row belongs to the same model (Flavor rows)
    const name = rawName || lastModelName;
    if (rawName) lastModelName = rawName;

    // Strip provider prefix (Meta/, google/, BAAI/, etc.)
    const cleanName = name.includes('/') ? name.split('/').pop() : name;
    if (!cleanName) continue;

    const flavor = flavorCol >= 0 ? (row[flavorCol] || '').trim() : '';
    const inputPrice = parseUsd(row[inputCol]);
    const outputPrice = outputCol >= 0 ? parseUsd(row[outputCol]) : 0;

    // Skip rows with no pricing at all (e.g. fast tier that's not yet launched)
    if (inputPrice === null || (inputPrice === 0 && outputPrice === 0 && flavor !== 'base')) continue;
    // Also skip "–" fast-only rows with no price
    if (inputPrice === 0 && flavor === 'fast') continue;

    const displayName = flavor ? `${cleanName} (${flavor})` : cleanName;
    const size_b = getSizeB(cleanName);

    const model = {
      name: displayName,
      type,
      input_price_per_1m: inputPrice,
      output_price_per_1m: outputPrice ?? 0,
      currency: 'USD',
    };
    if (size_b) model.size_b = size_b;
    if (flavor) model.flavor = flavor;

    models.push(model);
  }

  return models;
}

async function fetchNebius() {
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

  // Extract __NEXT_DATA__
  const ndMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!ndMatch) throw new Error('__NEXT_DATA__ not found in page');

  const nextData = JSON.parse(ndMatch[1]);
  const apollo = nextData?.props?.pageProps?.__APOLLO_STATE__;
  if (!apollo) throw new Error('__APOLLO_STATE__ not found');

  // Find the page entry whose content string contains pricing tables.
  // We search all Apollo state values for one with a stringified content containing "table".
  let pageContent = null;
  for (const val of Object.values(apollo)) {
    if (val && typeof val.content === 'string' && val.content.includes('"table"')) {
      try {
        pageContent = JSON.parse(val.content); // second parse
        if (pageContent) break;
      } catch { /* continue */ }
    }
  }
  if (!pageContent) throw new Error('Could not find pricing content block in Apollo state');

  // Collect all table blocks
  const tableBlocks = collectTables(pageContent);

  const allModels = [];

  tableBlocks.forEach(({ rows, context }, i) => {
    const header = (rows[0] || []).map((h) => (h || '').toLowerCase());

    // Skip non-pricing tables (post-training has 'model size', enterprise has 'capability')
    if (header[0] === 'model size' || header[0] === 'capability' || header[0] === 'feature') return;

    // Infer model type from surrounding context text
    const ctx = (context.title || context.description || '').toLowerCase();
    let tableType = 'chat';
    if (ctx.includes('embed')) tableType = 'embedding';
    else if (ctx.includes('image') || ctx.includes('flux')) tableType = 'image';
    else if (ctx.includes('vision')) tableType = 'vision';
    else if (ctx.includes('gemma') || ctx.includes('guard') || ctx.includes('llama-guard')) tableType = 'chat';
    else if (header.includes('flavor')) tableType = 'chat';
    else if (!header.includes('output')) {
      // Single-price column without output — check if it looks like embeddings or image
      const firstModelName = (rows[1]?.[0] || '').toLowerCase();
      if (firstModelName.includes('bge') || firstModelName.includes('embed')) tableType = 'embedding';
      else tableType = 'image';
    }

    const models = modelsFromTable({ rows });
    models.forEach((m) => {
      m.type = tableType;
      if (tableType === 'vision') m.capabilities = ['vision'];
    });
    allModels.push(...models);
  });

  return allModels;
}

module.exports = { fetchNebius, providerName: 'Nebius' };

// Run standalone: node scripts/providers/nebius.js
if (require.main === module) {
  fetchNebius()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Nebius:\n`);
      const byType = {};
      models.forEach((m) => {
        (byType[m.type] = byType[m.type] || []).push(m);
      });
      for (const [type, ms] of Object.entries(byType)) {
        console.log(`  [${type}]`);
        ms.forEach((m) =>
          console.log(`    ${m.name.padEnd(55)} $${m.input_price_per_1m} / $${m.output_price_per_1m}`)
        );
      }
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
