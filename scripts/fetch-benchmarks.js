'use strict';

/**
 * Fetch benchmark data from six sources and merge into data/benchmarks.json.
 *
 * Sources:
 *   1. AchilleasDrakou/LLMStats on GitHub (71 curated models, self-reported benchmarks)
 *   2. open-llm-leaderboard/contents on Hugging Face (4500+ open models, standardised evals)
 *   3. LiveBench (livebench.ai) — contamination-free, monthly, 70+ frontier models
 *   4. Chatbot Arena (lmarena.ai) — 316 models with real ELO ratings from human votes
 *   5. Aider (aider.chat) — code editing benchmark, 133 tasks per model
 *   6. Artificial Analysis (artificialanalysis.ai) — independent evaluations and speed benchmarks
 *
 * Unified field names (0-1 scale unless noted):
 *   mmlu, mmlu_pro, gpqa, human_eval, math, gsm8k, mmmu,
 *   hellaswag, ifeval, arc, drop, mbpp, mgsm, bbh  (from LLMStats)
 *   hf_math_lvl5, hf_musr, hf_avg, params_b        (HF-only)
 *   lb_name, lb_global, lb_reasoning, lb_coding,    (LiveBench, 0-1)
 *   lb_math, lb_language, lb_if, lb_data_analysis
 *   arena_elo, arena_rank, arena_votes               (Chatbot Arena; elo is raw ELO ~800-1500)
 *   aider_pass_rate                                  (Aider edit bench, 0-1)
 *   aa_id, aa_intelligence, aa_mmlu_pro, aa_gpqa,    (Artificial Analysis)
 *   aa_livecodebench, aa_tokens_per_s, aa_latency_s
 *
 * Where multiple sources have data for the same benchmark,
 * LLMStats takes priority (it stores self-reported model-card values).
 *
 * Usage:
 *   node scripts/fetch-benchmarks.js             # fetch all sources
 *   node scripts/fetch-benchmarks.js aa          # refresh Artificial Analysis only
 *   node scripts/fetch-benchmarks.js livebench   # refresh LiveBench only
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { getJson, getText } = require('./fetch-utils');
const { loadEnv } = require('./load-env');

loadEnv();

const OUT_FILE = path.join(__dirname, '..', 'data', 'benchmarks.json');

// ─── helpers ────────────────────────────────────────────────────────────────

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
        const metrics = extractLLMStatsMetrics(data.qualitative_metrics);
        const entry = { slug, name: data.name, ...metrics, sources: {} };
        Object.keys(metrics).forEach(k => entry.sources[k] = 'llmstats');
        return entry;
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
        sources: {},
      };
      if (r['#Params (B)'])     { entry.params_b      = r['#Params (B)']; entry.sources.params_b = 'hf'; }
      if (r['IFEval Raw'])      { entry.ifeval        = r['IFEval Raw']; entry.sources.ifeval = 'hf'; }
      if (r['BBH Raw'])         { entry.bbh           = r['BBH Raw']; entry.sources.bbh = 'hf'; }
      if (r['GPQA Raw'])        { entry.gpqa          = r['GPQA Raw']; entry.sources.gpqa = 'hf'; }
      if (r['MMLU-PRO Raw'])    { entry.mmlu_pro      = r['MMLU-PRO Raw']; entry.sources.mmlu_pro = 'hf'; }
      if (r['MATH Lvl 5 Raw'])  { entry.hf_math_lvl5  = r['MATH Lvl 5 Raw']; entry.sources.hf_math_lvl5 = 'hf'; }
      if (r['MUSR Raw'])        { entry.hf_musr       = r['MUSR Raw']; entry.sources.hf_musr = 'hf'; }
      if (AVG_KEY && r[AVG_KEY]) { entry.hf_avg       = r[AVG_KEY]; entry.sources.hf_avg = 'hf'; }
      return entry;
    });

  console.log(`  HF: ${entries.length} entries after filtering`);
  return entries;
}

// ─── LiveBench ───────────────────────────────────────────────────────────────

const LB_GITHUB_TREE = 'https://api.github.com/repos/LiveBench/livebench.github.io/git/trees/main?recursive=1';
const LB_BASE_URL    = 'https://livebench.ai';

const LB_SUFFIX_RE = new RegExp(
  '(-thinking-(?:auto-)?(?:\\d+k-)?(?:(?:high|medium|low)-effort)?|' +
  '-thinking(?:-(?:64k|32k|auto|minimal))?|' +
  '-(?:high|medium|low)-effort|' +
  '-base|-non-?reasoning|-(?:high|low|min)thinking|-nothinking)' +
  '(?:-(?:high|medium|low)-effort)?$'
);

function lbBaseName(name) {
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
    const entry = {
      lb_name:          modelName,
      lb_global:        allScores.length ? avg(allScores) : undefined,
      lb_reasoning:     groupBuckets.lb_reasoning    ? avg(groupBuckets.lb_reasoning)    : undefined,
      lb_coding:        groupBuckets.lb_coding        ? avg(groupBuckets.lb_coding)        : undefined,
      lb_math:          groupBuckets.lb_math          ? avg(groupBuckets.lb_math)          : undefined,
      lb_language:      groupBuckets.lb_language      ? avg(groupBuckets.lb_language)      : undefined,
      lb_if:            groupBuckets.lb_if            ? avg(groupBuckets.lb_if)            : undefined,
      lb_data_analysis: groupBuckets.lb_data_analysis ? avg(groupBuckets.lb_data_analysis) : undefined,
      sources: {},
    };
    Object.keys(entry).forEach(k => {
      if (k.startsWith('lb_') && entry[k] !== undefined) entry.sources[k] = 'livebench';
    });
    entries.push(entry);
  }
  return entries;
}

async function fetchLiveBench() {
  process.stdout.write('LiveBench: finding all releases... ');
  const tree = await getJson(LB_GITHUB_TREE);
  const dates = tree.tree
    .filter((f) => f.path.startsWith('public/table_') && f.path.endsWith('.csv'))
    .map((f) => f.path.replace('public/table_', '').replace('.csv', ''))
    .sort();
  console.log(`${dates.length} releases (${dates[0]} → ${dates[dates.length - 1]})`);

  const cats = await getJson(`${LB_BASE_URL}/categories_${dates[dates.length - 1]}.json`);
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

  const byName = new Map();
  for (const date of dates) {
    let csv;
    try { csv = await getText(`${LB_BASE_URL}/table_${date}.csv`); } 
    catch (e) { console.warn(`\n  ⚠ LiveBench ${date}: ${e.message}`); continue; }
    for (const entry of parseLiveBenchCsv(csv, taskToGroup)) byName.set(entry.lb_name, entry);
    process.stdout.write(`  LiveBench: ${date}\r`);
  }
  const entries = [...byName.values()];
  console.log(`  LiveBench: ${entries.length} unique models across all releases`);
  return entries;
}

function mergeLiveBench(entries, lbEntries) {
  const exactMap = new Map();
  const baseMap  = new Map();
  for (const lb of lbEntries) {
    exactMap.set(normName(lb.lb_name), lb);
    const base = normName(lbBaseName(lb.lb_name));
    if (base !== normName(lb.lb_name)) {
      const prev = baseMap.get(base);
      if (!prev || (lb.lb_global || 0) > (prev.lb_global || 0)) baseMap.set(base, lb);
    }
  }
  const usedLbNames = new Set();
  let matched = 0;
  for (const e of entries) {
    const candidates = [normName(e.name || ''), normName((e.slug || '').split('/').pop() || ''), normName((e.hf_id || '').split('/').pop() || '')].filter(Boolean);
    let lb = null;
    for (const c of candidates) { lb = exactMap.get(c) || baseMap.get(c); if (lb) break; }
    if (lb) { 
      Object.assign(e, lb); 
      e.sources = { ...(e.sources || {}), ...(lb.sources || {}) };
      usedLbNames.add(lb.lb_name); 
      matched++; 
    }
  }
  const usedBases = new Set([...usedLbNames].map((n) => normName(lbBaseName(n))));
  const newEntries = [];
  for (const lb of lbEntries) {
    if (usedLbNames.has(lb.lb_name)) continue;
    const base = normName(lbBaseName(lb.lb_name));
    if (usedBases.has(base)) continue;
    if (baseMap.get(base) === lb || exactMap.get(normName(lb.lb_name)) === lb) {
      newEntries.push({ name: lbBaseName(lb.lb_name), ...lb });
      usedBases.add(base);
    }
  }
  console.log(`  LiveBench: ${matched} matched, ${newEntries.length} new entries`);
  return [...entries, ...newEntries];
}

// ─── Chatbot Arena ───────────────────────────────────────────────────────────

async function fetchChatbotArena() {
  process.stdout.write('Chatbot Arena: fetching RSC leaderboard... ');
  const text = await getText('https://lmarena.ai/en/leaderboard/text', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'RSC': '1', 'Accept': 'text/x-component' },
  });
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
  return entries.map((e) => {
    const entry = {
      arena_name:  e.modelDisplayName,
      arena_org:   e.modelOrganization,
      arena_elo:   e.rating,
      arena_rank:  e.rank,
      arena_votes: e.votes,
      sources: {},
    };
    Object.keys(entry).forEach(k => {
      if (k.startsWith('arena_') && entry[k] !== undefined) entry.sources[k] = 'arena';
    });
    return entry;
  });
}

function mergeArena(entries, arenaEntries) {
  const arenaMap = new Map();
  for (const a of arenaEntries) arenaMap.set(normName(a.arena_name), a);
  let matched = 0;
  for (const e of entries) {
    const candidates = [normName(e.name || ''), normName(e.lb_name || ''), normName((e.slug || '').split('/').pop() || ''), normName((e.hf_id || '').split('/').pop() || '')];
    const a = candidates.map((c) => arenaMap.get(c)).find(Boolean);
    if (a) {
      e.arena_elo = a.arena_elo; e.arena_rank = a.arena_rank; e.arena_votes = a.arena_votes;
      e.sources = { ...(e.sources || {}), ...(a.sources || {}) };
      arenaMap.delete(normName(a.arena_name)); matched++;
    }
  }
  const newEntries = [];
  for (const a of arenaMap.values()) newEntries.push({ name: a.arena_name, ...a });
  console.log(`  Arena: ${matched} matched, ${newEntries.length} new entries`);
  return [...entries, ...newEntries];
}

// ─── Aider ───────────────────────────────────────────────────────────────────

const AIDER_RAW = 'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/edit_leaderboard.yml';

async function fetchAider() {
  process.stdout.write('Aider: fetching edit leaderboard... ');
  const text = await getText(AIDER_RAW);
  const rows = yaml.load(text);
  const best = new Map();
  for (const row of rows) {
    if (!row.model || row.pass_rate_1 === undefined) continue;
    const key = normName(row.model);
    const existing = best.get(key);
    if (!existing || row.pass_rate_1 > existing.pass_rate_1) best.set(key, row);
  }
  const entries = [];
  for (const row of best.values()) {
    const entry = { aider_model: row.model, aider_pass_rate: row.pass_rate_1 / 100, sources: {} };
    entry.sources.aider_pass_rate = 'aider';
    entries.push(entry);
  }
  console.log(`${entries.length} models (best run each)`);
  return entries;
}

function mergeAider(entries, aiderEntries) {
  const aiderMap = new Map();
  for (const a of aiderEntries) aiderMap.set(normName(a.aider_model), a);
  let matched = 0;
  for (const e of entries) {
    const candidates = [normName(e.name || ''), normName(e.lb_name || ''), normName((e.slug || '').split('/').pop() || ''), normName((e.hf_id || '').split('/').pop() || ''), normName(e.arena_name || '')];
    const a = candidates.map((c) => aiderMap.get(c)).find(Boolean);
    if (a) { 
      e.aider_pass_rate = a.aider_pass_rate; 
      e.sources = { ...(e.sources || {}), ...(a.sources || {}) };
      aiderMap.delete(normName(a.aider_model)); 
      matched++; 
    }
  }
  const newEntries = [];
  for (const a of aiderMap.values()) newEntries.push({ name: a.aider_model, ...a });
  console.log(`  Aider: ${matched} matched, ${newEntries.length} new entries`);
  return [...entries, ...newEntries];
}

// ─── Artificial Analysis ───────────────────────────────────────────────────

async function fetchArtificialAnalysis() {
  const apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  if (!apiKey) {
    console.log('Artificial Analysis: skipping (no API key found)');
    return [];
  }

  process.stdout.write('Artificial Analysis: fetching benchmarks... ');
  const res = await getJson('https://artificialanalysis.ai/api/v2/data/llms/models', {
    headers: { 'x-api-key': apiKey },
  });

  if (!res.data) throw new Error('Invalid response from Artificial Analysis API');
  console.log(`${res.data.length} models`);

  return res.data.map((m) => {
    const ev = m.evaluations || {};
    const entry = {
      aa_id: m.id,
      aa_name: m.name,
      aa_slug: m.slug,
      aa_intelligence: ev.artificial_analysis_intelligence_index, // 0-100
      aa_coding: ev.artificial_analysis_coding_index, // 0-100
      aa_math: ev.artificial_analysis_math_index, // 0-100
      aa_mmlu_pro: ev.mmlu_pro, // 0-1
      aa_gpqa: ev.gpqa, // 0-1
      aa_livecodebench: ev.livecodebench, // 0-1
      aa_hle: ev.hle,
      aa_scicode: ev.scicode,
      aa_math_500: ev.math_500,
      aa_aime: ev.aime,
      aa_tokens_per_s: m.median_output_tokens_per_second,
      aa_latency_s: m.median_time_to_first_token_seconds,
      sources: {},
    };
    Object.keys(entry).forEach(k => {
      if (k.startsWith('aa_') && entry[k] !== undefined) entry.sources[k] = 'aa';
    });
    return entry;
  });
}

function mergeArtificialAnalysis(entries, aaEntries) {
  const aaMap = new Map();
  for (const a of aaEntries) aaMap.set(normName(a.aa_name), a);

  let matched = 0;
  for (const e of entries) {
    const candidates = [
      normName(e.name || ''),
      normName(e.lb_name || ''),
      normName((e.slug || '').split('/').pop() || ''),
      normName((e.hf_id || '').split('/').pop() || ''),
      normName(e.arena_name || ''),
    ].filter(Boolean);

    const aa = candidates.map((c) => aaMap.get(c)).find(Boolean);
    if (aa) {
      Object.assign(e, aa);
      e.sources = { ...(e.sources || {}), ...(aa.sources || {}) };
      aaMap.delete(normName(aa.aa_name));
      matched++;
    }
  }

  const newEntries = [];
  for (const a of aaMap.values()) {
    newEntries.push({ name: a.aa_name, ...a });
  }

  console.log(`  AA: ${matched} matched, ${newEntries.length} new entries`);
  return [...entries, ...newEntries];
}

// ─── MTEB ──────────────────────────────────────────────────────────────────

const MTEB_PATHS_URL = 'https://raw.githubusercontent.com/embeddings-benchmark/results/main/paths.json';
const MTEB_RAW_BASE_URL = 'https://raw.githubusercontent.com/embeddings-benchmark/results/main/';

async function fetchMTEB() {
  const providersPath = path.join(__dirname, '..', 'data', 'providers.json');
  if (!fs.existsSync(providersPath)) return [];
  
  process.stdout.write('MTEB: fetching results index... ');
  const paths = await getJson(MTEB_PATHS_URL);
  const providers = JSON.parse(fs.readFileSync(providersPath, 'utf8')).providers;
  const hfIds = new Set();
  providers.forEach(p => p.models.forEach(m => { if (m.type === 'embedding' && m.hf_id) hfIds.add(m.hf_id); }));
  console.log(`${hfIds.size} embedders`);

  const results = [];
  for (const hfId of hfIds) {
    const key = hfId.replace(/\//g, '__');
    // Try original key, then find matching key in paths (case-insensitive)
    let resultPaths = paths[key];
    if (!resultPaths) {
      const match = Object.keys(paths).find(k => k.toLowerCase() === key.toLowerCase());
      if (match) resultPaths = paths[match];
    }
    if (!resultPaths) continue;

    const revisions = [...new Set(resultPaths.map(p => p.split('/')[2]))];
    // Aggregation: we'll take all unique tasks across all revisions, 
    // prioritizing the latest revision for each task.
    const taskPaths = new Map();
    revisions.forEach(rev => {
      const pathsInRev = resultPaths.filter(p => p.includes(`/${rev}/`));
      pathsInRev.forEach(p => {
        const taskName = p.split('/').pop().replace('.json', '');
        taskPaths.set(taskName, p);
      });
    });
    
    const latestPaths = [...taskPaths.values()];
    const fetchPaths = latestPaths.slice(0, 50); // Limit to 50 tasks to prevent hangs
    process.stdout.write(`  MTEB: ${hfId} (fetching ${fetchPaths.length}/${latestPaths.length} tasks)\r`);
    
    let total = 0, count = 0, retTotal = 0, retCount = 0;
    const BATCH = 20;
    for (let i = 0; i < fetchPaths.length; i += BATCH) {
      const batch = await Promise.all(fetchPaths.slice(i, i + BATCH).map(p => getJson(MTEB_RAW_BASE_URL + p).catch(() => null)));
      batch.forEach(res => {
        if (!res) return;
        const scores = res.scores || res;
        const data = scores.test || scores.dev || scores.validation;
        if (!data) return;
        const arr = Array.isArray(data) ? data : [data];
        
        // Find English or default subset
        let targetRes = arr.find(r => r.languages && r.languages.some(l => l.startsWith('eng') || l === 'en'));
        if (!targetRes && arr.length === 1) targetRes = arr[0];
        if (!targetRes) targetRes = arr.find(r => r.hf_subset === 'default');
        if (!targetRes && arr.length > 0) targetRes = arr[0];

        if (targetRes) {
          const s = targetRes.main_score || targetRes.ndcg_at_10 || targetRes.accuracy;
          if (typeof s === 'number' && s > 0) {
            let norm = s <= 1.0 ? s * 100 : s;
            if (norm > 100) norm = 100; // Cap at 100
            total += norm; count++;
            const task = res.mteb_dataset_name || res.task_name || '';
            if (task.includes('Retrieval') || task.includes('Search')) { retTotal += norm; retCount++; }
          }
        }
      });
    }
    if (count > 0) {
      results.push({
        hf_id: hfId,
        name: hfId.split('/').pop(),
        mteb_avg: Math.round(total / count * 100) / 100,
        mteb_retrieval: retCount > 0 ? Math.round(retTotal / retCount * 100) / 100 : undefined,
        sources: { mteb_avg: 'mteb', mteb_retrieval: retCount > 0 ? 'mteb' : undefined }
      });
    }
  }
  console.log(`\n  MTEB: ${results.length} models enriched            `);
  return results;
}

function mergeMTEB(entries, mtebEntries) {
  const map = new Map(mtebEntries.map(m => [m.hf_id.toLowerCase(), m]));
  
  // Manual overrides for famous models not yet in the results repo or needing fixed values
  const overrides = [
    { hf_id: 'BAAI/bge-multilingual-gemma2', mteb_avg: 70.3, mteb_retrieval: 67.5, sources: { mteb_avg: 'manual', mteb_retrieval: 'manual' } },
    { hf_id: 'Qwen/Qwen3-Embedding-8B', mteb_avg: 71.2, mteb_retrieval: 72.1, sources: { mteb_avg: 'manual', mteb_retrieval: 'manual' } },
    { hf_id: 'BAAI/bge-en-icl', mteb_avg: 64.9, mteb_retrieval: 58.2, sources: { mteb_avg: 'manual', mteb_retrieval: 'manual' } },
    { hf_id: 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2', mteb_avg: 51.98, mteb_retrieval: 39.76, sources: { mteb_avg: 'manual', mteb_retrieval: 'manual' } },
  ];
  overrides.forEach(o => {
    map.set(o.hf_id.toLowerCase(), o); // Force override
  });

  let matched = 0;
  for (const e of entries) {
    const m = e.hf_id ? map.get(e.hf_id.toLowerCase()) : null;
    if (m) {
      e.mteb_avg = m.mteb_avg;
      if (m.mteb_retrieval) e.mteb_retrieval = m.mteb_retrieval;
      e.sources = { ...(e.sources || {}), ...m.sources };
      map.delete(m.hf_id.toLowerCase()); matched++;
    }
  }
  const newEntries = [...map.values()];
  console.log(`  MTEB: ${matched} matched, ${newEntries.length} new entries`);
  return [...entries, ...newEntries];
}

// ─── Merge ───────────────────────────────────────────────────────────────────

function mergeEntries(llmstats, hfEntries) {
  const lsIdx = new Map();
  llmstats.forEach((e, i) => {
    lsIdx.set(normName(e.name), i);
    const slugModel = e.slug?.split('/').pop() || '';
    if (slugModel) lsIdx.set(normName(slugModel), i);
  });
  const merged = llmstats.map((e) => ({ ...e, sources: { ...(e.sources || {}) } }));
  const hfOnly = [];
  for (const hf of hfEntries) {
    const modelPart = normName(hf.name);
    const modelWords = modelPart.split(' ');
    const modelNoPrefix = modelWords.length > 1 ? modelWords.slice(1).join(' ') : modelPart;
    const idx = lsIdx.get(modelPart) ?? lsIdx.get(modelNoPrefix);
    if (idx !== undefined) {
      const target = merged[idx];
      if (!target.hf_id) target.hf_id = hf.hf_id;
      if (!target.params_b) target.params_b = hf.params_b;
      if (!target.ifeval) target.ifeval = hf.ifeval;
      if (!target.bbh) target.bbh = hf.bbh;
      if (!target.gpqa) target.gpqa = hf.gpqa;
      if (!target.mmlu_pro) target.mmlu_pro = hf.mmlu_pro;
      target.hf_math_lvl5 = hf.hf_math_lvl5;
      target.hf_musr = hf.hf_musr;
      target.hf_avg = hf.hf_avg;
      target.sources = { ...(target.sources || {}), ...(hf.sources || {}) };
    } else hfOnly.push(hf);
  }
  return [...merged, ...hfOnly];
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

const SOURCE_FIELDS = {
  llmstats:  ['slug', 'mmlu', 'mmlu_pro', 'gpqa', 'human_eval', 'math', 'gsm8k', 'mmmu', 'hellaswag', 'ifeval', 'arc', 'drop', 'mbpp', 'mgsm', 'bbh'],
  hf:        ['hf_id', 'params_b', 'hf_math_lvl5', 'hf_musr', 'hf_avg'],
  livebench: ['lb_name', 'lb_global', 'lb_reasoning', 'lb_coding', 'lb_math', 'lb_language', 'lb_if', 'lb_data_analysis'],
  arena:     ['arena_name', 'arena_org', 'arena_elo', 'arena_rank', 'arena_votes'],
  aider:     ['aider_model', 'aider_pass_rate'],
  aa:        ['aa_id', 'aa_intelligence', 'aa_coding', 'aa_math', 'aa_mmlu_pro', 'aa_gpqa', 'aa_livecodebench', 'aa_hle', 'aa_scicode', 'aa_math_500', 'aa_aime', 'aa_tokens_per_s', 'aa_latency_s'],
  mteb:      ['mteb_avg', 'mteb_retrieval'],
};

const SOURCE_ID_FIELD = {
  llmstats: 'slug', hf: 'hf_id', livebench: 'lb_name', arena: 'arena_elo', aider: 'aider_pass_rate', aa: 'aa_intelligence', mteb: 'mteb_avg',
};

async function refreshSource(source) {
  if (!SOURCE_FIELDS[source]) {
    console.error(`Unknown source "${source}". Valid: ${Object.keys(SOURCE_FIELDS).join(', ')}`);
    process.exit(1);
  }
  console.log(`Refreshing benchmark source: ${source}\n`);
  const existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  const otherIdFields = Object.values(SOURCE_ID_FIELD).filter(f => f !== SOURCE_ID_FIELD[source]);
  const stripped = existing.filter(e => otherIdFields.some(f => e[f] !== undefined)).map(e => {
    const s = { ...e }; for (const f of SOURCE_FIELDS[source]) delete s[f]; return s;
  });
  let result;
  if (source === 'llmstats') result = mergeLLMStatsInto(stripped, await fetchLLMStats());
  else if (source === 'hf') result = mergeHFInto(stripped, await fetchHFLeaderboard());
  else if (source === 'livebench') result = mergeLiveBench(stripped, await fetchLiveBench());
  else if (source === 'arena') result = mergeArena(stripped, await fetchChatbotArena());
  else if (source === 'aider') result = mergeAider(stripped, await fetchAider());
  else if (source === 'aa') result = mergeArtificialAnalysis(stripped, await fetchArtificialAnalysis());
  else if (source === 'mteb') result = mergeMTEB(stripped, await fetchMTEB());
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
}

// ─── HF README Evaluation ──────────────────────────────────────────────────

async function fetchHFReadmeBenchmarks() {
  const providersPath = path.join(__dirname, '..', 'data', 'providers.json');
  if (!fs.existsSync(providersPath)) return [];
  
  const providers = JSON.parse(fs.readFileSync(providersPath, 'utf8')).providers;
  const hfIds = new Set();
  providers.forEach(p => p.models.forEach(m => { if (m.hf_id) hfIds.add(m.hf_id); }));
  
  process.stdout.write(`HF README: checking ${hfIds.size} models... `);
  const results = [];
  
  const BATCH = 10;
  const ids = Array.from(hfIds);
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const rows = await Promise.all(batch.map(async (hfId) => {
      try {
        const url = `https://huggingface.co/${hfId}/raw/main/README.md`;
        const text = await getText(url, { retries: 1 });
        if (!text.startsWith('---')) return null;
        
        const endYaml = text.indexOf('---', 3);
        if (endYaml === -1) return null;
        
        const yamlText = text.substring(3, endYaml);
        const meta = yaml.load(yamlText);
        if (!meta || !meta['model-index']) return null;
        
        let total = 0, count = 0, retTotal = 0, retCount = 0;
        const modelIndex = Array.isArray(meta['model-index']) ? meta['model-index'] : [meta['model-index']];
        modelIndex.forEach(mi => {
          (mi.results || []).forEach(res => {
            const isMTEB = (res.dataset?.type || '').toLowerCase().includes('mteb') || 
                          (res.dataset?.name || '').toLowerCase().includes('mteb') ||
                          (res.task?.type || '').toLowerCase().includes('retrieval');
            if (!isMTEB) return;
            
            const mainMetric = (res.metrics || []).find(m => m.type === 'main_score' || m.type === 'ndcg_at_10' || m.type === 'accuracy');
            if (mainMetric && typeof mainMetric.value === 'number') {
              const val = mainMetric.value;
              let norm = val <= 1.0 ? val * 100 : val;
              if (norm > 100) norm = 100; // Cap at 100
              total += norm; count++;
              
              const taskType = (res.task?.type || '').toLowerCase();
              if (taskType.includes('retrieval') || taskType.includes('search')) {
                retTotal += norm; retCount++;
              }
            }
          });
        });
        
        if (count > 0) {
          return {
            hf_id: hfId,
            name: hfId.split('/').pop(),
            mteb_avg: Math.round(total / count * 100) / 100,
            mteb_retrieval: retCount > 0 ? Math.round(retTotal / retCount * 100) / 100 : undefined,
            sources: { mteb_avg: 'hf-readme', mteb_retrieval: retCount > 0 ? 'hf-readme' : undefined }
          };
        }
      } catch (e) {
        return null;
      }
      return null;
    }));
    rows.forEach(r => { if (r) results.push(r); });
    process.stdout.write(`  HF README: ${Math.min(i + BATCH, ids.length)}/${ids.length}\r`);
  }
  
  console.log(`\n  HF README: ${results.length} models enriched from metadata`);
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const source = process.argv[2]?.toLowerCase();
  if (source) { await refreshSource(source); return; }

  const [llmstats, hfEntries, lbEntries, arenaEntries, aiderEntries, aaEntries, mtebEntries, readmeEntries] = await Promise.all([
    fetchLLMStats(),
    fetchHFLeaderboard(),
    fetchLiveBench(),
    fetchChatbotArena(),
    fetchAider(),
    fetchArtificialAnalysis(),
    fetchMTEB(),
    fetchHFReadmeBenchmarks(),
  ]);

  const merged  = mergeEntries(llmstats, hfEntries);
  const withLB  = mergeLiveBench(merged, lbEntries);
  const withAr  = mergeArena(withLB, arenaEntries);
  const withAi  = mergeAider(withAr, aiderEntries);
  const withAA  = mergeArtificialAnalysis(withAi, aaEntries);
  const withMTEB = mergeMTEB(withAA, mtebEntries);
  const all     = mergeMTEB(withMTEB, readmeEntries);

  console.log(`\nTotal entries: ${all.length}`);
  console.log(`  With LiveBench: ${all.filter(e => e.lb_name).length} | Arena: ${all.filter(e => e.arena_elo).length} | Aider: ${all.filter(e => e.aider_pass_rate !== undefined).length} | AA: ${all.filter(e => e.aa_intelligence !== undefined).length} | MTEB: ${all.filter(e => e.mteb_avg !== undefined).length}`);

  fs.writeFileSync(OUT_FILE, JSON.stringify(all, null, 2));
  console.log(`Saved to data/benchmarks.json (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB)`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
