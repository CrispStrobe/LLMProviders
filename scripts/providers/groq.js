'use strict';

/**
 * Groq pricing fetcher.
 *
 * groq.com/pricing is GONE (2026) — it now 302s to the marketing homepage, and
 * the old scraper that parsed <table class="type-ui-1"> off it had been
 * silently returning 0 models. Pricing moved to the console docs model table:
 *
 *   https://console.groq.com/docs/models
 *
 * That page is a React Server Components route, so the prices are not in the
 * served HTML as markup — they live in the RSC flight payload, pushed as JSON
 * string literals via self.__next_f.push([1,"..."]). We concatenate and decode
 * those, then read each model's price block, which is keyed "<model-id>-price":
 *
 *   ["$","div","openai/gpt-oss-20b-price",{...,"children":[
 *      ["$","span",null,{"children":["$$0.075"," ",[..."children":"input"}]]}],
 *      ["$","span",null,{"children":["$$0.30"," ",[..."children":"output"}]]}]]}]
 *
 * ("$$" is RSC's escape for a literal "$".) Three price shapes occur:
 *   input/output          -> USD per 1M tokens
 *   "per hour"            -> ASR, converted to price_per_minute
 *   "per 1M characters"   -> TTS, kept as input_price_per_1m (per-M chars),
 *                            which is how the previous fetcher stored it too
 *
 * Groq has moved its flagship Llama models (llama-3.1-8b-instant,
 * llama-3.3-70b-versatile) and MiniMax to "Contact Sales" with no public rate.
 * Those are skipped rather than invented — note this means a listed price may
 * exist on aggregators (OpenRouter still routes Groq Llama at $0.59/$0.79)
 * while Groq itself no longer publishes one.
 *
 * api.groq.com/openai/v1/models is the authoritative catalog but is key-gated
 * and carries no pricing at all (id, object, created, owned_by, active,
 * context_window, max_completion_tokens), so it cannot drive this fetcher.
 * Context windows are left to the global enrichment sweep instead of being
 * scraped out of the surrounding RSC row, which is far more fragile.
 *
 * Source: https://console.groq.com/docs/models  (verified 2026-09-11, 11 priced models)
 */

const { loadEnv } = require('../load-env');
loadEnv();
const { getText, getJson } = require('../fetch-utils');

const DOCS_URL = 'https://console.groq.com/docs/models';
const API_URL = 'https://api.groq.com/openai/v1/models';

// Each flight chunk is a JSON string literal inside self.__next_f.push([1,...]).
const FLIGHT_RE = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;

// "$$0.075"," ",["$","span",null,{"className":"...","children":"input"}]
const PRICE_RE =
  /\$\$([\d.,]+)"," ",\["\$","span",null,\{"className":"[^"]*","children":"([^"]+)"\}\]/g;

const AUDIO_KEYWORDS = ['whisper', 'orpheus', 'playai', 'tts'];

const num = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

const getSizeB = (id) => {
  const m = (id || '').match(/(?:\b|-)(\d+(?:\.\d+)?)\s*[Bb](?:\b|-|:|$)/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return n > 0 && n < 2000 ? n : undefined;
};

function decodeFlightPayload(html) {
  let payload = '';
  let m;
  FLIGHT_RE.lastIndex = 0;
  while ((m = FLIGHT_RE.exec(html)) !== null) {
    try {
      payload += JSON.parse(m[1]);
    } catch {
      // A chunk that will not parse is skipped; the rest still decodes.
    }
  }
  return payload;
}

/**
 * Optional first-party catalog enrichment.
 *
 * GET /openai/v1/models is authoritative for which models exist and their
 * context windows, but carries no pricing — so it supplements the scraped
 * prices rather than replacing them. Requires GROQ_API_KEY; without it the
 * fetcher still returns fully priced models, just without context windows.
 * Returns null when unavailable so callers can skip enrichment silently.
 */
async function fetchCatalog() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  try {
    const data = await getJson(API_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      retries: 2,
    });
    const byId = new Map();
    for (const m of data.data || []) {
      if (m.id) byId.set(m.id, m);
    }
    return byId;
  } catch (err) {
    console.warn(`  (Groq catalog lookup failed: ${err.message} — prices kept, no context windows)`);
    return null;
  }
}

function classify(id) {
  const s = (id || '').toLowerCase();
  if (AUDIO_KEYWORDS.some((k) => s.includes(k))) return { type: 'audio', caps: ['audio'] };
  return { type: 'chat', caps: [] };
}

async function fetchGroq() {
  const html = await getText(DOCS_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const payload = decodeFlightPayload(html);
  if (!payload) {
    throw new Error('No RSC flight payload found on Groq docs page (page shape changed?)');
  }

  // Every price block is keyed "<model-id>-price".
  const marks = [...payload.matchAll(/"([^"]+)-price"/g)].map((m) => ({
    id: m[1],
    at: m.index,
  }));
  if (marks.length === 0) {
    throw new Error('No "<model>-price" blocks in Groq flight payload (page shape changed?)');
  }

  const models = [];
  const seen = new Set();
  let contactSales = 0;

  for (let i = 0; i < marks.length; i++) {
    const { id, at } = marks[i];
    if (seen.has(id)) continue;

    // Bound the window at whichever comes first: this model's own "-limits"
    // block, or the next model's price block. Without both bounds an adjacent
    // model's figures bleed in (gpt-oss-20b picked up prompt-guard's $0.03).
    const limitsAt = payload.indexOf(`"${id}-limits"`, at);
    const nextMark = i + 1 < marks.length ? marks[i + 1].at : Infinity;
    const end = Math.min(
      limitsAt > at ? limitsAt : Infinity,
      nextMark,
      at + 900,
      payload.length
    );
    const window = payload.slice(at, end);

    const entry = { name: id, currency: 'USD' };
    let priced = false;

    PRICE_RE.lastIndex = 0;
    let p;
    while ((p = PRICE_RE.exec(window)) !== null) {
      const value = num(p[1]);
      const label = p[2].toLowerCase().trim();
      if (value === undefined) continue;

      // First value wins — a bleed past the window bound must not overwrite
      // the figure that actually belongs to this model.
      if (label === 'input') {
        if (entry.input_price_per_1m === undefined) entry.input_price_per_1m = value;
        priced = true;
      } else if (label === 'output') {
        if (entry.output_price_per_1m === undefined) entry.output_price_per_1m = value;
        priced = true;
      } else if (label.includes('per hour')) {
        entry.price_per_minute = Math.round((value / 60) * 1e6) / 1e6;
        priced = true;
      } else if (label.includes('per 1m characters')) {
        // TTS bills per million characters, not tokens — same unit slot.
        entry.input_price_per_1m = value;
        entry.output_price_per_1m = 0;
        priced = true;
      }
    }

    if (!priced) {
      // "Contact Sales" — Groq publishes no rate for this model any more.
      contactSales++;
      continue;
    }

    const { type, caps } = classify(id);
    entry.type = type;
    if (caps.length) entry.capabilities = caps;
    if (entry.input_price_per_1m !== undefined && entry.output_price_per_1m === undefined) {
      entry.output_price_per_1m = 0;
    }

    const size_b = getSizeB(id);
    if (size_b) entry.size_b = size_b;

    seen.add(id);
    models.push(entry);
  }

  if (contactSales) {
    console.warn(`  (skipped ${contactSales} Groq model(s) priced "Contact Sales")`);
  }
  if (models.length === 0) {
    throw new Error('Groq flight payload parsed but no priced models found');
  }

  const catalog = await fetchCatalog();
  if (catalog) {
    let enriched = 0;
    for (const m of models) {
      const info = catalog.get(m.name);
      if (!info) continue;
      if (info.context_window) { m.context_window = info.context_window; enriched++; }
    }
    console.log(`  (Groq catalog: context windows for ${enriched}/${models.length} models)`);
  }

  models.sort((a, b) => (a.input_price_per_1m ?? 0) - (b.input_price_per_1m ?? 0));
  return models;
}

module.exports = { fetchGroq, providerName: 'Groq' };

// Run standalone: node scripts/providers/groq.js
if (require.main === module) {
  fetchGroq()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Groq\n`);
      models.forEach((m) =>
        console.log(
          `  ${m.name.padEnd(38)} ${m.type.padEnd(7)} ` +
            (m.price_per_minute != null
              ? `$${m.price_per_minute}/min`
              : `$${m.input_price_per_1m} / $${m.output_price_per_1m}`)
        )
      );
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
