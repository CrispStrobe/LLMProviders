'use strict';

/**
 * Nscale Serverless Inference — pay-per-token, OpenAI-compatible.
 * HQ London (UK); serverless inference runs on Nscale's sustainable European
 * (Norway/EEA) data centres. Not EU-headquartered, so jurisdiction is UK GDPR
 * + EEA hosting rather than full EU sovereignty — see the provider `region`.
 *
 * The catalog + pricing come from the authenticated OpenAI-compatible
 * `GET /v1/models` endpoint (docs page is access-gated, so we use the API).
 * Schema: { data: [{ id, owned_by, pricing: { input, output }, context_length }] }
 * where pricing.input/output are USD per 1M tokens (per 1M pixels for image
 * output). The endpoint carries no type/capability fields, so those are
 * derived from the model id (as the Requesty/Scaleway fetchers do).
 *
 * Requires NSCALE_API_KEY (local ../AIToolkit/.env or a CI secret). Without it
 * the fetcher skips and the provider keeps its existing data.
 */

const { loadEnv } = require('../load-env');
loadEnv();
const { getJson } = require('../fetch-utils');

const API_URL = 'https://inference.api.nscale.com/v1/models';

const loadApiKey = () => process.env.NSCALE_API_KEY || null;

const EMBED_KEYWORDS = ['embed', 'bge', 'gte', 'e5-', 'stella', 'arctic-embed', 'nomic-embed'];
const IMAGE_KEYWORDS = ['flux', 'stable-diffusion', 'sdxl', 'sd3', 'text-to-image'];
const VISION_KEYWORDS = ['-vl', 'vl-', 'vision', 'pixtral', 'llava', 'llama-4'];
const REASON_KEYWORDS = ['deepseek-r1', 'qwq', 'thinking', 'magistral', 'gpt-oss', 'reason'];

const getSizeB = (id) => {
  const match = (id || '').match(/(?:\b|-)(\d+(?:\.\d+)?)[Bb](?:\b|-|:|$)/);
  if (!match) return undefined;
  const n = parseFloat(match[1]);
  return n > 0 && n < 2000 ? n : undefined;
};

// USD per 1M — the endpoint already reports per-million, keep as-is.
const perMillion = (v) => (v == null ? 0 : Math.round(parseFloat(v) * 10000) / 10000);

function classify(id) {
  const s = (id || '').toLowerCase();
  const isImage = IMAGE_KEYWORDS.some((k) => s.includes(k));
  if (isImage) return { type: 'image', caps: [] };
  if (EMBED_KEYWORDS.some((k) => s.includes(k))) return { type: 'embedding', caps: [] };

  const caps = [];
  const isVision = VISION_KEYWORDS.some((k) => s.includes(k));
  if (isVision) caps.push('vision');
  if (REASON_KEYWORDS.some((k) => s.includes(k))) caps.push('reasoning');
  return { type: isVision ? 'vision' : 'chat', caps };
}

async function fetchNscale() {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.warn('  (no NSCALE_API_KEY found – skipping Nscale)');
    return [];
  }

  const data = await getJson(API_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });

  const models = [];
  let skippedImage = 0;

  for (const m of data.data || []) {
    const id = m.id;
    if (!id) continue;

    const input = perMillion(m.pricing?.input);
    const output = perMillion(m.pricing?.output);
    const { type, caps } = classify(id);

    // Image pricing is per-megapixel (not per-image / per-token), a different
    // unit than our schema expresses — skip rather than publish misleading data.
    if (type === 'image') { skippedImage++; continue; }

    const entry = {
      name: id,
      type,
      input_price_per_1m: input,
      output_price_per_1m: output,
      currency: 'USD',
    };
    if (caps.length) entry.capabilities = caps;
    if (m.context_length) entry.context_window = m.context_length;

    // Nscale ids are Hugging Face style (owner/model) — use as hf_id for enrichment.
    if (/^[^/\s]+\/[^/\s]+$/.test(id)) entry.hf_id = id;

    const size_b = getSizeB(id);
    if (size_b) entry.size_b = size_b;

    models.push(entry);
  }

  if (skippedImage) console.warn(`  (skipped ${skippedImage} image model(s) — per-megapixel pricing not representable)`);

  models.sort((a, b) => a.input_price_per_1m - b.input_price_per_1m);
  return models;
}

module.exports = { fetchNscale, providerName: 'Nscale' };

// Run standalone: node scripts/providers/nscale.js
if (require.main === module) {
  fetchNscale()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Nscale API\n`);
      models.slice(0, 20).forEach((m) =>
        console.log(`  ${m.name.padEnd(50)} ${m.type.padEnd(10)} $${m.input_price_per_1m} / $${m.output_price_per_1m}`)
      );
      if (models.length > 20) console.log(`  ... and ${models.length - 20} more`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
