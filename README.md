# LLM Providers

**Live: [llmproviders.vercel.app](https://llmproviders.vercel.app) or [Hugging Face Space](https://huggingface.co/spaces/cstr/LLMProviders)**

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
| OVHcloud | EU 🇫🇷 | GDPR-compliant, sovereign, pay-per-token |
| STACKIT | EU 🇩🇪 | Schwarz Group, fully sovereign (no US hyperscaler) |
| Nscale | EEA 🇬🇧/🇳🇴 | UK HQ, EEA (Norway) hosting, pay-per-token — **needs `NSCALE_API_KEY` or stays empty** |
| EUrouter | EU 🇳🇱 | EUrouter B.V., Amsterdam; EU-only sub-processors. Routes across EU providers — but see the caveat below |
| HostYourAI | EU 🇳🇱 | HostYourAI B.V.; open models on EU GPUs via vLLM, DPA + EU Sovereignty Mode |
| Mistral AI | EU 🇫🇷 | GDPR-compliant |
| Black Forest Labs | EU 🇩🇪 | FLUX image models |
| OpenRouter | US | Aggregator, 400+ models public |
| Requesty | US | Aggregator with EU endpoints |
| Groq | US | Fast inference — only its publicly priced models appear, see below |

### Sovereignty and pricing caveats

Things the numbers alone do not tell you, worth knowing before choosing on price:

- **EUrouter is an EU controller, but not every route is EU.** A minority of its
  models are served upstream by AWS Bedrock or Microsoft Foundry and are
  therefore Cloud Act-exposed despite the Dutch front door. Those models do
  **not** carry the `eu-endpoint` capability; the upstream is recorded in
  `provider_upstream` for every model either way, so the exposure is visible
  rather than hidden behind the provider-level flag.
- **HostYourAI is per-token only here.** Its dedicated GPU (per hour) and
  private deployment (per month) tiers are capacity rentals this schema has no
  unit for, so they are not represented. Its published cached-input column is
  also dropped — there is no cached-price field yet.
- **Groq no longer publishes a rate for its flagship Llamas.**
  `llama-3.1-8b-instant`, `llama-3.3-70b-versatile` and MiniMax are
  "Contact Sales", so they are absent rather than guessed. Aggregators may
  still quote a Groq price that Groq itself does not publish.
- **Currencies are carried, not converted.** Models keep the currency their
  provider bills in (EUR/USD/CHF); EUrouter mixes EUR and USD within one
  catalog.

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
npm run fetch:eurouter      # EUrouter
npm run fetch:hostyourai    # HostYourAI
npm run fetch:openrouter    # OpenRouter
npm run fetch:requesty      # Requesty
npm run fetch:nebius        # Nebius
npm run fetch:mistral       # Mistral AI
npm run fetch:scaleway      # Scaleway
npm run fetch:ovhcloud      # OVHcloud
npm run fetch:stackit       # STACKIT
npm run fetch:nscale        # Nscale (needs NSCALE_API_KEY)
npm run fetch:langdock      # Langdock
npm run fetch:groq          # Groq
npm run fetch:ionos         # IONOS
npm run fetch:infomaniak    # Infomaniak
npm run fetch:bfl           # Black Forest Labs
```

Each fetcher is standalone and prints what it found, which is the quickest way
to see whether an upstream page or API has changed shape. A fetcher that
returns nothing is **not** written to the data file — `fetch-providers.js`
keeps the last-good models instead of wiping them, so silent upstream breakage
shows up in `npm run healthcheck`, not as missing data:

```bash
npm run healthcheck         # runs every fetcher, fails if one collapses
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

API keys — all optional, checked in `scripts/load-env.js`. Every other provider
is fetched from a public, keyless source, so a clone with no `.env` at all
still populates almost the whole table:

```
NSCALE_API_KEY=...         # REQUIRED for Nscale — its catalog is only behind
                           #   the API, so without this Nscale stays empty
OPENROUTER_API_KEY=...     # optional; unlocks the full catalog vs public subset
GROQ_API_KEY=...           # optional; adds context windows to Groq models
REQUESTY_API_KEY=...       # optional; Requesty currently returns its catalog
                           #   publicly, so this is not needed today
```

Place in `.env` in the project root or `../AIToolkit/.env`. In CI they are read
from repository secrets of the same name; a missing secret makes that fetcher
skip rather than fail, so forks work without any.

## Deployment

The app is a fully static Vite build — deploy anywhere that serves static files.

```bash
npm run build       # produces dist/
vercel --prod       # deploy to Vercel
```

The management panel (⚙ Manage Data) is local-only and shows an offline notice in production, which is expected.

## Automation

Data keeps itself current through GitHub Actions — enable them on your fork and
nothing else is needed:

| Workflow | Schedule | What it does |
|---|---|---|
| `update-providers.yml` | daily 06:00 UTC | Runs every fetcher, commits `data/providers.json` if it changed, then syncs to the HF Space (needs `HF_TOKEN`) |
| `update-benchmarks.yml` | weekly, Sun 04:00 UTC | Refreshes `data/benchmarks.json` |
| `healthcheck.yml` | daily 12:00 UTC, and on PRs touching `scripts/` | Runs every fetcher and goes red if one collapses; also builds the app |

Both data workflows also accept a manual **Run workflow** trigger from the
Actions tab. Pushing the committed JSON is what redeploys Vercel, so the daily
commit refreshes the live site on its own.

A provider whose source is public and keyless needs no workflow change at all —
registering it in `FETCHER_MODULES` is enough for the daily run to include it.

## Adding a Provider

1. Create `scripts/providers/<name>.js` exporting `{ providerName, fetch<Name> }`
2. Register it in `scripts/fetch-providers.js` under `FETCHER_MODULES`
3. Add an entry in `data/providers.json`
4. Add an npm script in `package.json`
5. Add it to `CHECKS` in `scripts/healthcheck.js` with a `min` set well below
   the live count — without this the fetcher can break silently, since
   `fetch-providers.js` keeps last-good data on an empty result

Public, keyless sources need no workflow change: the daily `update-providers`
run picks them up from `FETCHER_MODULES`. A fetcher needing a key should return
`[]` when it is absent (see `nscale.js`) and declare `keyEnv` in the health
check, so forks without secrets still pass.

## License

[GNU Affero General Public License v3.0](LICENSE)
