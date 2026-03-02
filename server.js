'use strict';

/**
 * Management API server for the providers comparison app.
 * Runs on port 3001 (Vite dev server runs on 5173).
 *
 * Routes:
 *   GET  /api/status              → provider status (model counts, last updated)
 *   POST /api/fetch/:provider     → run one provider's fetcher
 *   POST /api/fetch               → run all providers
 */

const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data', 'providers.json');
const BENCHMARKS_FILE = path.join(__dirname, 'data', 'benchmarks.json');
const SCRIPTS_DIR = path.join(__dirname, 'scripts', 'providers');
const BENCHMARKS_SCRIPT = path.join(__dirname, 'scripts', 'fetch-benchmarks.js');

// In-memory state: which providers/benchmark sources are currently being refreshed
const refreshing = new Set();

// Valid benchmark source keys (must match fetch-benchmarks.js SOURCE_FIELDS keys)
const BENCHMARK_SOURCES = ['llmstats', 'hf', 'livebench', 'arena', 'aider'];

// Allow cross-origin requests from the Vite dev server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// Serve built static files in production
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

// ------------------------------------------------------------------
// GET /api/data        → serve providers.json live (for HF Space / local)
// GET /api/benchmarks  → serve benchmarks.json live
// ------------------------------------------------------------------
app.get('/api/data', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch { res.status(500).json({ error: 'Failed to read providers data' }); }
});

app.get('/api/benchmarks', (req, res) => {
  try {
    if (!fs.existsSync(BENCHMARKS_FILE)) return res.status(404).json([]);
    res.json(JSON.parse(fs.readFileSync(BENCHMARKS_FILE, 'utf8')));
  } catch { res.status(500).json({ error: 'Failed to read benchmarks data' }); }
});

// ------------------------------------------------------------------
// GET /api/status
// Returns per-provider: model count, lastUpdated, whether a fetcher script exists
// ------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  const status = data.providers.map((p) => {
    const key = p.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    // Check if a fetcher script exists for this provider
    const scriptPath = path.join(SCRIPTS_DIR, `${key}.js`);
    // Also try common name variations (e.g. "mistral-ai" → "mistral")
    const altKey = key.replace(/-ai$/, '').replace(/-/g, '');
    const altScript = path.join(SCRIPTS_DIR, `${altKey}.js`);
    const hasScript = fs.existsSync(scriptPath) || fs.existsSync(altScript);
    const scriptKey = fs.existsSync(scriptPath) ? key : (fs.existsSync(altScript) ? altKey : null);

    return {
      name: p.name,
      key: scriptKey || key,
      modelCount: p.models?.length ?? 0,
      lastUpdated: p.lastUpdated ?? null,
      hasScript,
      refreshing: refreshing.has(p.name),
    };
  });

  // Include benchmark dataset info (benchmarks.json is a plain array; use file mtime for lastUpdated)
  let benchmarks = null;
  if (fs.existsSync(BENCHMARKS_FILE)) {
    try {
      const bm = JSON.parse(fs.readFileSync(BENCHMARKS_FILE, 'utf8'));
      const mtime = fs.statSync(BENCHMARKS_FILE).mtime.toISOString();
      benchmarks = {
        entryCount: Array.isArray(bm) ? bm.length : (bm.entries?.length ?? 0),
        lastUpdated: mtime,
        refreshing: refreshing.has('__benchmarks__'),
        sources: BENCHMARK_SOURCES.map((key) => ({
          key,
          refreshing: refreshing.has(`__benchmarks__:${key}`),
        })),
      };
    } catch { /* ignore */ }
  }

  res.json({ providers: status, benchmarks });
});

// ------------------------------------------------------------------
// POST /api/fetch/:provider   (provider = script key, e.g. "scaleway")
// POST /api/fetch             (runs all providers that have a script)
// ------------------------------------------------------------------
function runFetcher(providerName, scriptKey) {
  return new Promise((resolve) => {
    if (refreshing.has(providerName)) {
      return resolve({ provider: providerName, success: false, error: 'Already refreshing' });
    }

    const scriptPath = path.join(SCRIPTS_DIR, `${scriptKey}.js`);
    if (!fs.existsSync(scriptPath)) {
      return resolve({ provider: providerName, success: false, error: 'No fetcher script' });
    }

    refreshing.add(providerName);

    // Run the main orchestrator for just this provider
    execFile(
      process.execPath,
      [path.join(__dirname, 'scripts', 'fetch-providers.js'), scriptKey],
      { cwd: __dirname, timeout: 60000 },
      (err, stdout, stderr) => {
        refreshing.delete(providerName);

        // Stamp lastUpdated on the provider entry in providers.json
        try {
          const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
          const prov = d.providers.find((p) => p.name === providerName);
          if (prov) {
            prov.lastUpdated = new Date().toISOString();
            fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
          }
        } catch { /* best effort */ }

        if (err) {
          resolve({ provider: providerName, success: false, error: err.message, stderr });
        } else {
          resolve({ provider: providerName, success: true, output: stdout });
        }
      }
    );
  });
}

// ------------------------------------------------------------------
// POST /api/fetch/benchmarks/:source  (refresh one benchmark source)
// POST /api/fetch/benchmarks          (refresh all benchmark sources)
// ------------------------------------------------------------------
app.post('/api/fetch/benchmarks/:source', async (req, res) => {
  const { source } = req.params;
  if (!BENCHMARK_SOURCES.includes(source)) {
    return res.json({ success: false, error: `Unknown source: ${source}` });
  }
  const key = `__benchmarks__:${source}`;
  if (refreshing.has(key)) {
    return res.json({ success: false, error: 'Already refreshing' });
  }
  refreshing.add(key);
  execFile(
    process.execPath,
    [BENCHMARKS_SCRIPT, source],
    { cwd: __dirname, timeout: 300000 },
    (err, stdout, stderr) => {
      refreshing.delete(key);
      if (err) res.json({ success: false, error: err.message, stderr });
      else res.json({ success: true });
    }
  );
});

app.post('/api/fetch/benchmarks', async (req, res) => {
  if (refreshing.has('__benchmarks__')) {
    return res.json({ success: false, error: 'Already refreshing' });
  }
  refreshing.add('__benchmarks__');
  execFile(
    process.execPath,
    [BENCHMARKS_SCRIPT],
    { cwd: __dirname, timeout: 600000 },
    (err, stdout, stderr) => {
      refreshing.delete('__benchmarks__');
      if (err) res.json({ success: false, error: err.message, stderr });
      else res.json({ success: true });
    }
  );
});

app.post('/api/fetch/:provider', async (req, res) => {
  const scriptKey = req.params.provider;
  // Find the provider name by script key
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  // Try to match by lowercased name or script key
  const match = data.providers.find((p) => {
    const k = p.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const ak = k.replace(/-ai$/, '').replace(/-/g, '');
    return k === scriptKey || ak === scriptKey;
  });

  const providerName = match?.name ?? scriptKey;
  const result = await runFetcher(providerName, scriptKey);
  res.json(result);
});

app.post('/api/fetch', async (req, res) => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const scriptsAvailable = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace('.js', ''));

  const tasks = data.providers
    .filter((p) => {
      const key = p.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const altKey = key.replace(/-ai$/, '').replace(/-/g, '');
      return scriptsAvailable.includes(key) || scriptsAvailable.includes(altKey);
    })
    .map((p) => {
      const key = p.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const altKey = key.replace(/-ai$/, '').replace(/-/g, '');
      const scriptKey = scriptsAvailable.includes(key) ? key : altKey;
      return runFetcher(p.name, scriptKey);
    });

  const results = await Promise.all(tasks);
  res.json({ results });
});

// SPA catch-all: serve index.html for any non-API route
if (fs.existsSync(distDir)) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Management API server running at http://localhost:${PORT}`);
  console.log(`  GET  /api/data`);
  console.log(`  GET  /api/benchmarks`);
  console.log(`  GET  /api/status`);
  console.log(`  POST /api/fetch          (all providers)`);
  console.log(`  POST /api/fetch/:key     (single provider)`);
});
