'use strict';

/**
 * Nebius Token Factory (formerly Nebius AI Studio) pricing fetcher.
 *
 * Nebius rebranded to "Token Factory" and moved its pricing behind a
 * client-rendered app; the old server-rendered __NEXT_DATA__ pricing page is
 * gone. The authoritative, documented source is now the OpenAI-compatible
 * `GET /v1/models?verbose=true` endpoint, which returns OpenRouter-style
 * RichModel objects:
 *
 *   { id, name, context_length, architecture: { modality }, quantization,
 *     pricing: { prompt, completion, image, price_per_minute, ... } }
 *
 * pricing.* are USD PER TOKEN, encoded as strings (e.g. "0.000001"), so we
 * multiply by 1e6 for our per-1M convention. modality is "in->out"
 * (e.g. "text->text", "text+image->text").
 *
 * Requires NEBIUS_API_KEY (local ../AIToolkit/.env or a CI secret). Without it
 * the fetcher skips and the provider keeps its existing data.
 */

const { loadEnv } = require('../load-env');
loadEnv();
const { getJson } = require('../fetch-utils');

const API_URL = 'https://api.tokenfactory.nebius.com/v1/models?verbose=true';

const loadApiKey = () => process.env.NEBIUS_API_KEY || null;

// per-token string -> per-1M number
const perMillion = (v) => {
  const n = parseFloat(v);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1_000_000 * 10000) / 10000;
};

const getSizeB = (id) => {
  const match = (id || '').match(/[^.\d](\d+)[Bb]/) || (id || '').match(/^(\d+)[Bb]/);
  return match ? parseInt(match[1]) : undefined;
};

// Classify from OpenRouter-style modality "in->out" (+ id fallback).
function classify(modality, id) {
  const m = (modality || '').toLowerCase();
  const s = (id || '').toLowerCase();
  const [inPart = '', outPart = ''] = m.split('->');

  if (inPart.includes('audio') || outPart.includes('audio') || s.includes('whisper') || s.includes('voxtral')) {
    return { type: 'audio', caps: ['audio'] };
  }
  if (outPart.includes('image')) return { type: 'image', caps: ['image-gen'] };
  if (outPart.includes('embed') || m.includes('embedding') || s.includes('embed')) {
    return { type: 'embedding', caps: [] };
  }
  const caps = [];
  const isVision = inPart.includes('image');
  if (isVision) caps.push('vision');
  return { type: isVision ? 'vision' : 'chat', caps };
}

async function fetchNebius() {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.warn('  (no NEBIUS_API_KEY found – skipping Nebius)');
    return [];
  }

  const data = await getJson(API_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });

  const models = [];

  for (const m of data.data || []) {
    const id = m.id;
    if (!id) continue;

    const pricing = m.pricing || {};
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    const perMin = parseFloat(pricing.price_per_minute || '0') || 0;
    const perImage = parseFloat(pricing.image || '0') || 0;

    const { type, caps } = classify(m.architecture?.modality, id);

    const entry = { name: id, type, currency: 'USD' };
    if (caps.length) entry.capabilities = caps;

    if (type === 'audio' && perMin > 0) {
      entry.price_per_minute = Math.round(perMin * 1e6) / 1e6;
    } else if (type === 'image') {
      // Image models: `image` is a per-image price; prompt/completion usually 0.
      if (perImage > 0) entry.price_per_image = perImage;
      else { entry.input_price_per_1m = input; entry.output_price_per_1m = output; }
    } else {
      entry.input_price_per_1m = input;
      entry.output_price_per_1m = output;
    }

    // Drop entries we couldn't price at all (unavailable / placeholder rows).
    const hasPrice =
      entry.input_price_per_1m > 0 ||
      entry.output_price_per_1m > 0 ||
      entry.price_per_image > 0 ||
      entry.price_per_minute > 0;
    if (!hasPrice) continue;

    if (m.context_length) entry.context_window = m.context_length;
    if (/^[^/\s]+\/[^/\s]+$/.test(id)) entry.hf_id = id;
    const size_b = getSizeB(id);
    if (size_b) entry.size_b = size_b;

    models.push(entry);
  }

  models.sort((a, b) => (a.input_price_per_1m ?? 0) - (b.input_price_per_1m ?? 0));
  return models;
}

module.exports = { fetchNebius, providerName: 'Nebius' };

// Run standalone: node scripts/providers/nebius.js
if (require.main === module) {
  fetchNebius()
    .then((models) => {
      console.log(`Fetched ${models.length} models from Nebius:\n`);
      const byType = {};
      models.forEach((m) => { (byType[m.type] = byType[m.type] || []).push(m); });
      for (const [type, ms] of Object.entries(byType)) {
        console.log(`  [${type}]`);
        ms.slice(0, 30).forEach((m) => {
          const price = m.price_per_image !== undefined
            ? `$${m.price_per_image}/img`
            : m.price_per_minute !== undefined
              ? `$${m.price_per_minute}/min`
              : `$${m.input_price_per_1m} / $${m.output_price_per_1m}`;
          console.log(`    ${m.name.padEnd(55)} ${price}`);
        });
      }
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
