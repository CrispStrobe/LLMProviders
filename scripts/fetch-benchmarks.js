'use strict';

/**
 * Fetch benchmark data from five sources and merge into data/benchmarks.json.
 *
 * Sources:
 *   1. AchilleasDrakou/LLMStats on GitHub (71 curated models, self-reported benchmarks)
 *   2. open-llm-leaderboard/contents on Hugging Face (4500+ open models, standardised evals)
 *   3. LiveBench (livebench.ai) — contamination-free, monthly, 70+ frontier models
 *   4. Chatbot Arena (lmarena.ai) — 316 models with real ELO ratings from human votes
 *   5. Aider (aider.chat) — code editing benchmark, 133 tasks per model
 *
 * Unified field names (0-1 scale unless noted):
 *   mmlu, mmlu_pro, gpqa, human_eval, math, gsm8k, mmmu,
 *   hellaswag, ifeval, arc, drop, mbpp, mgsm, bbh  (from LLMStats)
 *   hf_math_lvl5, hf_musr, hf_avg, params_b        (HF-only)
 *   lb_name, lb_global, lb_reasoning, lb_coding,    (LiveBench, 0-1)
 *   lb_math, lb_language, lb_if, lb_data_analysis
 *   arena_elo, arena_rank, arena_votes               (Chatbot Arena; elo is raw ELO ~800-1500)
 *   aider_pass_rate                                  (Aider edit bench, 0-1)
 *
 * Where both sources have data for the same benchmark (gpqa, mmlu_pro, ifeval, bbh),
 * LLMStats takes priority (it stores self-reported model-card values).
 *
 * Usage: node scripts/fetch-benchmarks.js
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const OUT_FILE = path.join(__dirname, '..', 'data', 'benchmarks.json');

// ─── helpers ────────────────────────────────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'providers-benchmark-fetcher', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

const normName = (s) =>
  (s || '').toLowerCase().replace(/[-_.]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// ─── LLMStats ───────────────────────────────────────────────────────────────

const LLMSTATS_TREE = 'https://api.github.com/repos/AchilleasDrakou/LLMStats/git/trees/main?recursive=1';
const LLMSTATS_RAW  = 'https://raw.githubusercontent.com/AchilleasDrakou/LLMStats/main/';

const LLMSTATS_MAP = {
  mmlu:       ['MMLU', 'MMLU Chat', 'MMLU-Base', 'MMLU (CoT)', 'Multilingual MMLU'],
  mmlu_pro:   ['MMLU-Pro', 'MMLU-STEM', 'Multilingual MMLU-Pro'],
  gpqa:       ['GPQA'],
  human_eval: ['HumanEval', 'Humaneval', 'HumanEval+', 'HumanEval-Average', 'Instruct HumanEval', 'MBPP EvalPlus', 'EvalPlus', 'Evalplus'],
  math:       ['MATH', 'Math', 'MATH (CoT)', 'MATH-500', 'Functional_MATH', 'FunctionalMATH'],
  gsm8k:      ['GSM8K', 'GSM-8K', 'GSM8k', 'GSM8K Chat', 'GSM-8K (CoT)'],
  mmmu:       ['MMMU', 'MMMUval', 'MMMU-Pro'],
  hellaswag:  ['HellaSwag', 'HellaSWAG', 'Hellaswag'],
  ifeval:     ['IFEval', 'IF-Eval'],
  arc:        ['ARC Challenge', 'ARC-C', 'ARC-c', 'ARC-e', 'ARC-Challenge', 'AI2 Reasoning Challenge (ARC)'],
  drop:       ['DROP'],
  mbpp:       ['MBPP', 'MBPP+', 'MBPP++', 'MBPP pass@1', 'MBPP EvalPlus (base)'],
  mgsm:       ['MGSM', 'Multilingual MGSM', 'Multilingual MGSM (CoT)'],
  bbh:        ['BBH', 'BigBench Hard CoT', 'BIG-Bench-Hard', 'BigBench-Hard', 'BIG-Bench Hard', 'BigBench_Hard'],
};

function extractLLMStatsMetrics(qualitative_metrics) {
  const scores = {};
  for (const m of qualitative_metrics || []) {
    for (const [key, names] of Object.entries(LLMSTATS_MAP)) {
      if (names.some((n) => m.dataset_name === n) && scores[key] === undefined) {
        scores[key] = m.score;
      }
    }
  }
  return scores;
}

async function fetchLLMStats() {
  process.stdout.write('LLMStats: fetching file list... ');
  const tree = await getJson(LLMSTATS_TREE);
  const files = tree.tree.filter(
    (f) => f.type === 'blob' && f.path.startsWith('models/') && f.path.endsWith('/model.json')
  );
  console.log(`${files.length} models`);

  const results = [];
  const BATCH = 10;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const rows = await Promise.all(batch.map(async (f) => {
      try {
        const data = await getJson(LLMSTATS_RAW + f.path);
        const slug = f.path.replace(/^models\//, '').replace(/\/model\.json$/, '');
        return { slug, name: data.name, ...extractLLMStatsMetrics(data.qualitative_metrics) };
      } catch (e) {
        console.warn(`\n  ⚠ LLMStats ${f.path}: ${e.message}`);
        return null;
      }
    }));
    rows.forEach((r) => { if (r) results.push(r); });
    process.stdout.write(`  LLMStats: ${Math.min(i + BATCH, files.length)}/${files.length}\r`);
  }
  console.log(`  LLMStats: ${results.length} entries fetched            `);
  return results;
}

// ─── HF Leaderboard ─────────────────────────────────────────────────────────

const HF_ROWS_URL = 'https://datasets-server.huggingface.co/rows' +
  '?dataset=open-llm-leaderboard%2Fcontents&config=default&split=train';

async function fetchHFPage(offset, limit = 100) {
  const data = await getJson(`${HF_ROWS_URL}&offset=${offset}&limit=${limit}`);
  return { rows: data.rows.map((r) => r.row), total: data.num_rows_total };
}

async function fetchHFLeaderboard() {
  process.stdout.write('HF Leaderboard: probing total... ');
  const first = await fetchHFPage(0, 1);
  const total = first.total;
  console.log(`${total} rows`);

  const LIMIT = 100;
  const pages = Math.ceil(total / LIMIT);
  const allRows = [...first.rows];

  // Fetch remaining pages in batches of 5 concurrent requests
  const CONCURRENT = 5;
  for (let p = 1; p < pages; p += CONCURRENT) {
    const batch = [];
    for (let q = p; q < Math.min(p + CONCURRENT, pages); q++) {
      batch.push(fetchHFPage(q * LIMIT, LIMIT));
    }
    const results = await Promise.all(batch);
    results.forEach((r) => allRows.push(...r.rows));
    const done = Math.min((p + CONCURRENT) * LIMIT, total);
    process.stdout.write(`  HF: ${done}/${total}\r`);
  }
  console.log(`  HF: ${total}/${total} — filtering...            `);

  // The Average column name has a Unicode emoji
  const AVG_KEY = Object.keys(allRows[0]).find((k) => k.startsWith('Average'));

  const entries = allRows
    .filter((r) => r['Available on the hub'] && !r.Flagged)
    .map((r) => {
      const entry = {
        hf_id: r.fullname,
        name: r.fullname.split('/').pop(),
      };
      if (r['#Params (B)'])     entry.params_b      = r['#Params (B)'];
      if (r['IFEval Raw'])      entry.ifeval        = r['IFEval Raw'];
      if (r['BBH Raw'])         entry.bbh           = r['BBH Raw'];
      if (r['GPQA Raw'])        entry.gpqa          = r['GPQA Raw'];
      if (r['MMLU-PRO Raw'])    entry.mmlu_pro      = r['MMLU-PRO Raw'];
      if (r['MATH Lvl 5 Raw'])  entry.hf_math_lvl5  = r['MATH Lvl 5 Raw'];
      if (r['MUSR Raw'])        entry.hf_musr       = r['MUSR Raw'];
      if (AVG_KEY && r[AVG_KEY]) entry.hf_avg       = r[AVG_KEY];
      return entry;
    });

  console.log(`  HF: ${entries.length} entries after filtering`);
  return entries;
}

// ─── LiveBench ───────────────────────────────────────────────────────────────

const LB_GITHUB_TREE = 'https://api.github.com/repos/LiveBench/livebench.github.io/git/trees/main?recursive=1';
const LB_BASE_URL    = 'https://livebench.ai';

// Suffixes LiveBench appends to model names that providers don't use.
// We strip these to produce a "base" name for matching.
const LB_SUFFIX_RE = new RegExp(
  '(-thinking-(?:auto-)?(?:\\d+k-)?(?:(?:high|medium|low)-effort)?|' +
  '-thinking(?:-(?:64k|32k|auto|minimal))?|' +
  '-(?:high|medium|low)-effort|' +
  '-base|-non-?reasoning|-(?:high|low|min)thinking|-nothinking)' +
  '(?:-(?:high|medium|low)-effort)?$'  // handle double-suffix like -thinking-64k-high-effort
);

function lbBaseName(name) {
  // Repeatedly strip known suffixes until stable
  let prev;
  let cur = name;
  do { prev = cur; cur = cur.replace(LB_SUFFIX_RE, ''); } while (cur !== prev);
  return cur;
}

function parseLiveBenchCsv(csvText, taskToGroup) {
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const lines = csvText.split('\n').filter(Boolean);
  const headers = lines[0].split(',');
  const entries = [];
  for (const line of lines.slice(1)) {
    const vals = line.split(',');
    const modelName = vals[0];
    if (!modelName) continue;
    const taskScores = {};
    for (let i = 1; i < headers.length; i++) {
      const v = parseFloat(vals[i]);
      if (!isNaN(v)) taskScores[headers[i]] = v / 100;
    }
    const groupBuckets = {};
    for (const [task, group] of Object.entries(taskToGroup)) {
      if (taskScores[task] !== undefined) {
        groupBuckets[group] = groupBuckets[group] || [];
        groupBuckets[group].push(taskScores[task]);
      }
    }
    const allScores = Object.values(taskScores);
    entries.push({
      lb_name:          modelName,
      lb_global:        allScores.length ? avg(allScores) : undefined,
      lb_reasoning:     groupBuckets.lb_reasoning    ? avg(groupBuckets.lb_reasoning)    : undefined,
      lb_coding:        groupBuckets.lb_coding        ? avg(groupBuckets.lb_coding)        : undefined,
      lb_math:          groupBuckets.lb_math          ? avg(groupBuckets.lb_math)          : undefined,
      lb_language:      groupBuckets.lb_language      ? avg(groupBuckets.lb_language)      : undefined,
      lb_if:            groupBuckets.lb_if            ? avg(groupBuckets.lb_if)            : undefined,
      lb_data_analysis: groupBuckets.lb_data_analysis ? avg(groupBuckets.lb_data_analysis) : undefined,
    });
  }
  return entries;
}

async function fetchLiveBench() {
  process.stdout.write('LiveBench: finding all releases... ');
  const tree = await getJson(LB_GITHUB_TREE);
  const dates = tree.tree
    .filter((f) => f.path.startsWith('public/table_') && f.path.endsWith('.csv'))
    .map((f) => f.path.replace('public/table_', '').replace('.csv', ''))
    .sort(); // oldest first
  console.log(`${dates.length} releases (${dates[0]} → ${dates[dates.length - 1]})`);

  // Use task→group mapping from the latest categories JSON (stable across releases)
  const cats = await fetch(`${LB_BASE_URL}/categories_${dates[dates.length - 1]}.json`, {
    headers: { 'User-Agent': 'providers-benchmark-fetcher' },
  }).then((r) => r.json());

  const taskToGroup = {};
  for (const [cat, tasks] of Object.entries(cats)) {
    const group =
      cat === 'Coding' || cat === 'Agentic Coding' ? 'lb_coding' :
      cat === 'Reasoning'     ? 'lb_reasoning' :
      cat === 'Mathematics'   ? 'lb_math' :
      cat === 'Language'      ? 'lb_language' :
      cat === 'IF'            ? 'lb_if' :
      cat === 'Data Analysis' ? 'lb_data_analysis' : null;
    if (group) for (const t of tasks) taskToGroup[t] = group;
  }

  // Fetch all releases (oldest→newest), so newer results overwrite older ones per model
  // Map: lb_name → entry (most recent release wins)
  const byName = new Map();
  for (const date of dates) {
    let csv;
    try {
      csv = await fetch(`${LB_BASE_URL}/table_${date}.csv`, {
        headers: { 'User-Agent': 'providers-benchmark-fetcher' },
      }).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.text(); });
    } catch (e) {
      console.warn(`\n  ⚠ LiveBench ${date}: ${e.message}`);
      continue;
    }
    for (const entry of parseLiveBenchCsv(csv, taskToGroup)) {
      byName.set(entry.lb_name, entry); // newer release overwrites
    }
    process.stdout.write(`  LiveBench: ${date}\r`);
  }

  const entries = [...byName.values()];
  console.log(`  LiveBench: ${entries.length} unique models across all releases`);
  return entries;
}

function mergeLiveBench(entries, lbEntries) {
  // Build two lookups:
  //   exact: normalized lb_name → entry
  //   base:  normalized base-name (suffixes stripped) → best-scoring entry among variants
  const exactMap = new Map();
  const baseMap  = new Map(); // base → best lb entry by lb_global

  for (const lb of lbEntries) {
    exactMap.set(normName(lb.lb_name), lb);
    const base = normName(lbBaseName(lb.lb_name));
    if (base !== normName(lb.lb_name)) {
      const prev = baseMap.get(base);
      if (!prev || (lb.lb_global || 0) > (prev.lb_global || 0)) baseMap.set(base, lb);
    }
  }

  // Track which lb entries have been used (to avoid adding them as standalone new entries)
  const usedLbNames = new Set();

  let matched = 0;
  for (const e of entries) {
    const candidates = [
      normName(e.name || ''),
      normName((e.slug || '').split('/').pop() || ''),
      normName((e.hf_id || '').split('/').pop() || ''),
    ].filter(Boolean);

    let lb = null;
    for (const c of candidates) {
      lb = exactMap.get(c) || baseMap.get(c);
      if (lb) break;
    }
    if (lb) {
      Object.assign(e, lb);
      usedLbNames.add(lb.lb_name);
      matched++;
    }
  }

  // Add standalone entries for lbEntries not matched above.
  // Skip variants whose base was already matched (avoid duplicating e.g. all -effort variants).
  // Use the base model name (without -high-effort etc.) as the entry name so that
  // provider model names (which have no effort suffixes) can find this entry.
  const usedBases = new Set([...usedLbNames].map((n) => normName(lbBaseName(n))));
  const newEntries = [];
  for (const lb of lbEntries) {
    if (usedLbNames.has(lb.lb_name)) continue;
    const base = normName(lbBaseName(lb.lb_name));
    if (usedBases.has(base)) continue; // a variant of a matched model — skip
    // Only add the best-scoring variant of each base group
    if (baseMap.get(base) === lb || exactMap.get(normName(lb.lb_name)) === lb) {
      const baseName = lbBaseName(lb.lb_name); // e.g. "claude-opus-4-5-20251101"
      newEntries.push({ name: baseName, ...lb }); // name uses base; lb_name keeps variant
      usedBases.add(base);
    }
  }

  console.log(`  LiveBench: ${matched} matched, ${newEntries.length} new entries`);
  return [...entries, ...newEntries];
}

// ─── Merge ───────────────────────────────────────────────────────────────────

function mergeEntries(llmstats, hfEntries) {
  // Build lookup: normalized LLMStats name/slug → entry index
  const lsIdx = new Map();
  llmstats.forEach((e, i) => {
    lsIdx.set(normName(e.name), i);
    const slugModel = e.slug?.split('/').pop() || '';
    if (slugModel) lsIdx.set(normName(slugModel), i);
  });

  const merged = llmstats.map((e) => ({ ...e }));
  const hfOnly = [];

  for (const hf of hfEntries) {
    // Try matching by the model name part of the HF ID
    const modelPart = normName(hf.name);
    // Also try stripping a leading word (org prefix embedded in model name like "Meta-Llama-...")
    const modelWords = modelPart.split(' ');
    const modelNoPrefix = modelWords.length > 1 ? modelWords.slice(1).join(' ') : modelPart;

    const idx = lsIdx.get(modelPart) ?? lsIdx.get(modelNoPrefix);
    if (idx !== undefined) {
      // Merge HF fields into LLMStats entry (LLMStats wins for shared benchmarks)
      const target = merged[idx];
      if (!target.hf_id)         target.hf_id        = hf.hf_id;
      if (!target.params_b)      target.params_b      = hf.params_b;
      if (!target.ifeval)        target.ifeval        = hf.ifeval;
      if (!target.bbh)           target.bbh           = hf.bbh;
      if (!target.gpqa)          target.gpqa          = hf.gpqa;
      if (!target.mmlu_pro)      target.mmlu_pro      = hf.mmlu_pro;
      target.hf_math_lvl5 = hf.hf_math_lvl5;
      target.hf_musr      = hf.hf_musr;
      target.hf_avg       = hf.hf_avg;
    } else {
      hfOnly.push(hf);
    }
  }

  return [...merged, ...hfOnly];
}

// ─── Chatbot Arena ───────────────────────────────────────────────────────────

async function fetchChatbotArena() {
  process.stdout.write('Chatbot Arena: fetching RSC leaderboard... ');

  // The lmarena.ai leaderboard page renders via React Server Components.
  // Requesting with "RSC: 1" returns a streaming text/x-component payload that
  // embeds the full leaderboard entries (rank, ELO rating, votes) in the server
  // response — no authentication required.
  const text = await fetch('https://lmarena.ai/en/leaderboard/text', {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'RSC': '1',
      'Accept': 'text/x-component',
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });

  // Each RSC line has the format: <hex_id>:<json_value>
  // Find the line containing "entries":[...] with ELO ratings
  let entries = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"entries":[') || !line.includes('"rating":')) continue;
    const start = line.indexOf('"entries":[') + '"entries":'.length;
    let depth = 0, end = -1;
    for (let i = start; i < line.length; i++) {
      if (line[i] === '[' || line[i] === '{') depth++;
      else if (line[i] === ']' || line[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    entries = JSON.parse(line.substring(start, end));
    break;
  }

  if (!entries) throw new Error('Could not find entries in RSC payload');
  console.log(`${entries.length} models`);

  return entries.map((e) => ({
    arena_name:  e.modelDisplayName,
    arena_org:   e.modelOrganization,
    arena_elo:   e.rating,
    arena_rank:  e.rank,
    arena_votes: e.votes,
  }));
}

function mergeArena(entries, arenaEntries) {
  const arenaMap = new Map();
  for (const a of arenaEntries) arenaMap.set(normName(a.arena_name), a);

  let matched = 0;
  for (const e of entries) {
    const candidates = [
      normName(e.name || ''),
      normName((e.lb_name) || ''),
      normName((e.slug || '').split('/').pop() || ''),
      normName((e.hf_id || '').split('/').pop() || ''),
    ];
    const a = candidates.map((c) => arenaMap.get(c)).find(Boolean);
    if (a) {
      e.arena_elo   = a.arena_elo;
      e.arena_rank  = a.arena_rank;
      e.arena_votes = a.arena_votes;
      arenaMap.delete(normName(a.arena_name));
      matched++;
    }
  }

  const newEntries = [];
  for (const a of arenaMap.values()) {
    newEntries.push({ name: a.arena_name, ...a });
  }

  console.log(`  Arena: ${matched} matched, ${newEntries.length} new entries`);
  return [...entries, ...newEntries];
}

// ─── Aider ───────────────────────────────────────────────────────────────────

const AIDER_RAW = 'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/edit_leaderboard.yml';

async function fetchAider() {
  process.stdout.write('Aider: fetching edit leaderboard... ');
  const text = await fetch(AIDER_RAW, { headers: { 'User-Agent': 'providers-benchmark-fetcher' } }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });

  const rows = yaml.load(text);

  // Multiple runs per model — keep the one with the best pass_rate_1
  const best = new Map();
  for (const row of rows) {
    if (!row.model || row.pass_rate_1 === undefined) continue;
    const key = normName(row.model);
    const existing = best.get(key);
    if (!existing || row.pass_rate_1 > existing.pass_rate_1) best.set(key, row);
  }

  const entries = [];
  for (const row of best.values()) {
    entries.push({
      aider_model: row.model,
      aider_pass_rate: row.pass_rate_1 / 100, // normalize 0-100 → 0-1
    });
  }

  console.log(`${entries.length} models (best run each)`);
  return entries;
}

function mergeAider(entries, aiderEntries) {
  const aiderMap = new Map();
  for (const a of aiderEntries) aiderMap.set(normName(a.aider_model), a);

  let matched = 0;
  for (const e of entries) {
    const candidates = [
      normName(e.name || ''),
      normName((e.lb_name) || ''),
      normName((e.slug || '').split('/').pop() || ''),
      normName((e.hf_id || '').split('/').pop() || ''),
      normName((e.arena_name) || ''),
    ];
    const a = candidates.map((c) => aiderMap.get(c)).find(Boolean);
    if (a) {
      e.aider_pass_rate = a.aider_pass_rate;
      aiderMap.delete(normName(a.aider_model));
      matched++;
    }
  }

  const newEntries = [];
  for (const a of aiderMap.values()) {
    newEntries.push({ name: a.aider_model, aider_pass_rate: a.aider_pass_rate });
  }

  console.log(`  Aider: ${matched} matched, ${newEntries.length} new entries`);
  return [...entries, ...newEntries];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const [llmstats, hfEntries, lbEntries, arenaEntries, aiderEntries] = await Promise.all([
    fetchLLMStats(),
    fetchHFLeaderboard(),
    fetchLiveBench(),
    fetchChatbotArena(),
    fetchAider(),
  ]);

  const merged  = mergeEntries(llmstats, hfEntries);
  const withLB  = mergeLiveBench(merged, lbEntries);
  const withAr  = mergeArena(withLB, arenaEntries);
  const all     = mergeAider(withAr, aiderEntries);

  const hfOnlyCount = all.filter((e) => e.hf_id && !e.slug).length;
  const lsOnlyCount = all.filter((e) => e.slug && !e.hf_id).length;
  const bothCount   = all.filter((e) => e.slug && e.hf_id).length;
  const lbCount     = all.filter((e) => e.lb_name).length;
  const arenaCount  = all.filter((e) => e.arena_elo).length;
  const aiderCount  = all.filter((e) => e.aider_pass_rate !== undefined).length;
  console.log(`\nTotal entries: ${all.length}`);
  console.log(`  LLMStats only: ${lsOnlyCount} | HF only: ${hfOnlyCount} | Both: ${bothCount}`);
  console.log(`  With LiveBench: ${lbCount} | With Arena ELO: ${arenaCount} | With Aider: ${aiderCount}`);

  fs.writeFileSync(OUT_FILE, JSON.stringify(all, null, 2));
  console.log(`Saved to data/benchmarks.json (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
