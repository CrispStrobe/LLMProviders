---
title: LLM Providers
emoji: 📊
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# LLM Providers

**Live: [llmproviders.vercel.app](https://llmproviders.vercel.app)**

Compare pricing, capabilities, and benchmark scores across LLM providers — with a focus on European data-sovereignty options.

## Features

- **Price comparison** — input/output cost per 1M tokens (or per image) across all providers, normalized to USD
- **Jurisdiction filter** — filter by EU, US, or other regions; flags GDPR-compliant and Cloud Act-exposed providers
- **Capabilities** — vision 👁, reasoning 💡, tool use 🔧, image generation 🎨, audio, video, file input
- **Model types** — chat, vision, image-gen, embedding, audio
- **Benchmark scores** — Arena ELO, Aider pass rate, LiveBench, GPQA, MMLU-Pro, IFEval, BBH, HumanEval, and more
- **Group by model** — collapse providers behind each model to compare who offers it cheapest
- **Sort & search** — click any column header to sort; search filters model names instantly

## Providers

| Provider | Region | Note |
|---|---|---|
| IONOS | EU 🇩🇪 | GDPR-compliant, sovereign |
| Infomaniak | EU 🇨🇭 | Swiss, GDPR-compliant |
| Langdock | EU 🇩🇪 | GDPR-compliant, sovereign |
| Nebius | EU 🇫🇮 | GDPR-compliant |
| Scaleway | EU 🇫🇷 | GDPR-compliant |
| Mistral AI | EU 🇫🇷 | GDPR-compliant |
| Black Forest Labs | EU 🇩🇪 | FLUX image models |
| OpenRouter | US | Aggregator, 600+ models |
| Requesty | US | Aggregator with EU endpoints |
| Groq | US | Fast inference |

## Benchmark Sources

| Source | Models | Notes |
|---|---|---|
| [Chatbot Arena](https://lmarena.ai) | ~316 | Human-preference ELO ratings |
| [LiveBench](https://livebench.ai) | ~76 | Contamination-free, monthly updates |
| [Aider](https://aider.chat/docs/leaderboards/) | ~97 | Code editing benchmark |
| [HF Open LLM Leaderboard](https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard) | ~2900 | Standardised evals for open models |
| [LLMStats](https://github.com/AchilleasDrakou/LLMStats) | ~71 | Curated self-reported benchmarks |

## Stack

- **Frontend** — Vite + React 19 + TypeScript (static SPA, no backend)
- **Data** — `data/providers.json` and `data/benchmarks.json` bundled at build time
- **Fetchers** — Node.js scripts in `scripts/providers/` that scrape/call provider APIs
- **Management server** — local Express server (`server.js`) for live data refresh via the in-app panel

## Local Development

```bash
npm install

# Start the Vite dev server (port 5173)
npm run dev

# Start the management API server (port 3001) — enables the ⚙ Manage Data panel
node server.js
```

## Updating Data

Fetcher scripts pull live pricing from each provider and update `data/providers.json`:

```bash
npm run fetch               # all providers
npm run fetch:openrouter    # OpenRouter only
npm run fetch:requesty      # Requesty only (needs REQUESTY_API_KEY)
npm run fetch:nebius        # Nebius
npm run fetch:mistral       # Mistral AI
npm run fetch:scaleway      # Scaleway
npm run fetch:langdock      # Langdock
npm run fetch:groq          # Groq
npm run fetch:ionos         # IONOS
npm run fetch:infomaniak    # Infomaniak
npm run fetch:bfl           # Black Forest Labs
```

Benchmark data:

```bash
npm run fetch:benchmarks              # all sources (~10 min)
node scripts/fetch-benchmarks.js arena     # Chatbot Arena only (fast)
node scripts/fetch-benchmarks.js livebench # LiveBench only
node scripts/fetch-benchmarks.js aider     # Aider only
node scripts/fetch-benchmarks.js hf        # HF Leaderboard only (~5 min)
node scripts/fetch-benchmarks.js llmstats  # LLMStats only
```

API keys (optional — checked in `scripts/load-env.js`):

```
REQUESTY_API_KEY=...       # required for Requesty
OPENROUTER_API_KEY=...     # optional; unlocks 600+ models vs 342 public
```

Place in `.env` in the project root or `../AIToolkit/.env`.

## Deployment

The app is a fully static Vite build — deploy anywhere that serves static files.

```bash
npm run build       # produces dist/
vercel --prod       # deploy to Vercel
```

To update data after deployment: run the fetchers locally, commit the updated JSON files, and push — Vercel auto-redeploys on push.

The management panel (⚙ Manage Data) is local-only and shows an offline notice in production, which is expected.

## Adding a Provider

1. Create `scripts/providers/<name>.js` exporting `{ providerName, fetch<Name> }`
2. Register it in `scripts/fetch-providers.js` under `FETCHER_MODULES`
3. Add an entry in `data/providers.json`
4. Add an npm script in `package.json`

## License

[GNU Affero General Public License v3.0](LICENSE)
