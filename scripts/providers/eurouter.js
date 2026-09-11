'use strict';

/**
 * EUrouter — EU-sovereign model router, OpenAI-compatible.
 * EUrouter B.V. (KVK 42054357), Jacob van Lennepstraat 78H, Amsterdam, NL.
 * Own infrastructure runs on Scaleway (Amsterdam/Paris); the published
 * sub-processor list is EU-only (Scaleway, Mollie, PostHog Cloud EU, Brevo,
 * CaptchaFox, Better Stack EU).
 *
 * Catalog + pricing come from the PUBLIC OpenAI-compatible models endpoint —
 * no API key needed, so this fetcher runs unattended in CI.
 * Schema is OpenRouter-shaped:
 *   { data: [{ id, name, canonical_slug, hugging_face_id, context_length,
 *              architecture: { modality, input_modalities, output_modalities },
 *              supported_parameters: [...], supported_api_endpoints: [...],
 *              reasoning: { mandatory, supported_efforts },
 *              providers: [{ name, slug }],
 *              pricing: { prompt, completion, ..., discount, currency } }] }
 *
 * Pricing is per SINGLE token as a decimal string (e.g. "0.0000005"), and the
 * currency is per-model (EUR for EU-hosted upstreams, USD for the rest) — so
 * we multiply by 1e6 and carry `currency` through rather than converting.
 *
 * Sovereignty caveat: EUrouter is an EU entity, but a minority of its routes
 * sit on US hyperscalers (AWS Bedrock, Microsoft Foundry) and are therefore
 * Cloud Act-exposed. Those models are NOT tagged `eu-endpoint`; the upstream
 * is recorded in `provider_upstream` either way so the exposure is visible.
 *
 * Source: https://api.eurouter.ai/v1/models  (verified 2026-09-11, 147 models)
 */

const { getJson } = require('../fetch-utils');

const API_URL = 'https://api.eurouter.ai/v1/models';

// Upstreams that are not EU-established — routing to them forfeits the
// sovereignty claim even though EUrouter itself is a Dutch controller.
const NON_EU_UPSTREAMS = new Set(['aws bedrock', 'microsoft foundry']);

// Per-token decimal string -> per-1M. Prices go down to 1e-8/token, so keep
// six decimals rather than the four other fetchers use.
const perMillion = (v) => {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6 * 1e6) / 1e6;
};

const getSizeB = (s) => {
  const match = (s || '').match(/(?:\b|-)(\d+(?:\.\d+)?)\s*[Bb](?:\b|-|:|$)/);
  if (!match) return undefined;
  const n = parseFloat(match[1]);
  return n > 0 && n < 2000 ? n : undefined;
};

function classify(m) {
  const arch = m.architecture || {};
  const inputs = arch.input_modalities || [];
  const outputs = arch.output_modalities || [];
  const endpoints = m.supported_api_endpoints || [];

  const hasImageIn = inputs.includes('image');
  const hasVideoIn = inputs.includes('video');
  const hasAudioIn = inputs.includes('audio');

  const caps = [];
  if (hasImageIn) caps.push('vision');
  if (hasVideoIn) caps.push('video');
  if (hasAudioIn) caps.push('audio');
  if ((m.supported_parameters || []).includes('tools')) caps.push('tools');

  const r = m.reasoning || {};
  if (r.mandatory || (r.supported_efforts || []).length > 0) caps.push('reasoning');

  // Rerankers score inputs rather than generate — group them with embeddings,
  // which is the closest type this schema expresses.
  if (outputs.includes('embedding') || endpoints.includes('embeddings') || endpoints.includes('rerank')) {
    return { type: 'embedding', caps: caps.filter((c) => c === 'vision' || c === 'video') };
  }
  if (endpoints.includes('audio.transcriptions')) return { type: 'audio', caps };
  if (outputs.includes('image')) return { type: 'image', caps };

  return { type: hasImageIn || hasVideoIn ? 'vision' : 'chat', caps };
}

async function fetchEurouter() {
  const data = await getJson(API_URL, { headers: { Accept: 'application/json' } });
  const list = Array.isArray(data.data) ? data.data : [];
  if (list.length === 0) {
    throw new Error('EUrouter returned an empty model list (API shape changed?)');
  }

  const models = [];
  let skippedUnpriced = 0;
  let discountSeen = false;

  for (const m of list) {
    const id = m.id;
    if (!id) continue;

    // A handful of catalog entries (some embeddings/rerankers/ASR) carry no
    // pricing block at all — nothing to compare, so leave them out rather
    // than publish them as free.
    if (!m.pricing) { skippedUnpriced++; continue; }

    // `discount` has been a constant 1 (= no discount) since launch. If that
    // ever changes the prices below silently stop matching the invoice, so
    // surface it instead of guessing at the semantics.
    if (m.pricing.discount != null && Number(m.pricing.discount) !== 1) discountSeen = true;

    const { type, caps } = classify(m);
    const upstreams = (m.providers || []).map((p) => p.name).filter(Boolean);
    const allEu = upstreams.length > 0 && !upstreams.some((u) => NON_EU_UPSTREAMS.has(u.toLowerCase()));
    if (allEu) caps.push('eu-endpoint');

    const entry = {
      name: id,
      type,
      currency: (m.pricing.currency || 'USD').toUpperCase(),
      input_price_per_1m: perMillion(m.pricing.prompt),
      output_price_per_1m: perMillion(m.pricing.completion),
    };

    if (m.name && m.name !== id) entry.display_name = m.name;
    if (caps.length) entry.capabilities = caps;
    if (m.context_length) entry.context_window = m.context_length;
    if (m.hugging_face_id) entry.hf_id = m.hugging_face_id;
    if (upstreams.length) entry.provider_upstream = upstreams.join(', ');

    const size_b = getSizeB(m.hugging_face_id || m.name || id);
    if (size_b) entry.size_b = size_b;

    models.push(entry);
  }

  if (skippedUnpriced) {
    console.warn(`  (skipped ${skippedUnpriced} EUrouter model(s) with no pricing block)`);
  }
  if (discountSeen) {
    console.warn('  ⚠ EUrouter: pricing.discount is no longer 1 — listed prices may not match billing');
  }

  models.sort((a, b) => a.input_price_per_1m - b.input_price_per_1m);
  return models;
}

module.exports = { fetchEurouter, providerName: 'EUrouter' };

// Run standalone: node scripts/providers/eurouter.js
if (require.main === module) {
  fetchEurouter()
    .then((models) => {
      console.log(`Fetched ${models.length} models from EUrouter\n`);
      models.slice(0, 25).forEach((m) =>
        console.log(
          `  ${m.name.padEnd(42)} ${m.type.padEnd(10)} ${m.currency} ${String(m.input_price_per_1m).padStart(8)} / ${String(m.output_price_per_1m).padEnd(8)}` +
            (m.provider_upstream ? `  via ${m.provider_upstream}` : '')
        )
      );
      if (models.length > 25) console.log(`  ... and ${models.length - 25} more`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
