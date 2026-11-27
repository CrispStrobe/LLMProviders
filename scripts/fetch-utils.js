'use strict';

const MAX_REDIRECTS = 10;

/**
 * fetch() that follows redirects itself and carries cookies set along the way.
 * Some CDNs (OVHcloud since 2026-11) answer the first request with a 307 to the
 * same URL plus a session cookie; fetch() keeps no cookies, so it loops until
 * the redirect limit. Callers that set `redirect` themselves get plain fetch().
 */
async function fetchWithCookies(url, options) {
  if (options.redirect) return fetch(url, options);
  const jar = new Map();
  let current = url;
  for (let hop = 0; ; hop++) {
    const headers = new Headers(options.headers);
    if (jar.size) {
      const own = headers.get('Cookie');
      const carried = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      headers.set('Cookie', own ? `${own}; ${carried}` : carried);
    }
    const res = await fetch(current, { ...options, headers, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return res;
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${url}`);
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of setCookies) {
      const pair = line.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    await res.body?.cancel();
    current = new URL(location, current).toString();
  }
}

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
      const res = await fetchWithCookies(url, {
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
