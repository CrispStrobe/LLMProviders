'use strict';

/**
 * Robust fetch helper with retries, exponential backoff, and timeout.
 */
async function fetchRobust(url, options = {}) {
  const { retries = 5, backoff = 1000, timeout = 120000, ...fetchOptions } = options;
  let lastError;

  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          'User-Agent': 'providers-benchmark-fetcher',
          ...fetchOptions.headers,
        },
      });
      clearTimeout(timer);

      if (res.ok) return res;

      // Retry on transient status codes: 429 (Rate Limit), 408 (Timeout), and 5xx (Server Errors)
      if (res.status === 429 || res.status === 408 || (res.status >= 500 && res.status < 600)) {
        lastError = new Error(`HTTP ${res.status} from ${url}`);
        if (i < retries - 1) {
          const delay = backoff * Math.pow(2, i) + Math.random() * 1000;
          process.stdout.write(`\n  ⚠ ${lastError.message}. Retrying in ${Math.round(delay)}ms... (${i + 1}/${retries})\n`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      } else {
        // Don't retry on other 4xx errors (e.g. 404, 401, 403)
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const isTimeout = err.name === 'AbortError';
      const isAuthOrNotFound = err.message.includes('401') || err.message.includes('404');
      
      if (i < retries - 1 && !isAuthOrNotFound) {
        const delay = backoff * Math.pow(2, i) + Math.random() * 1000;
        const msg = isTimeout ? `Timeout after ${timeout}ms` : err.message;
        process.stdout.write(`\n  ⚠ Fetch error from ${url}: ${msg}. Retrying in ${Math.round(delay)}ms... (${i + 1}/${retries})\n`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }
  throw lastError;
}

async function getJson(url, options = {}) {
  const res = await fetchRobust(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
  return res.json();
}

async function getText(url, options = {}) {
  const res = await fetchRobust(url, options);
  return res.text();
}

module.exports = {
  fetchRobust,
  getJson,
  getText,
};
