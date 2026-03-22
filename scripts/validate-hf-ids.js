'use strict';

const fs = require('fs');
const path = require('path');
const { fetchRobust } = require('./fetch-utils');

const PROVIDERS_FILE = path.join(__dirname, '..', 'data', 'providers.json');

async function checkHfId(hfId) {
  if (!hfId) return { valid: true, status: 'N/A' };
  const url = `https://huggingface.co/${hfId}`;
  try {
    const res = await fetchRobust(url, { method: 'HEAD', retries: 1 });
    if (res.status === 200 || res.status === 302) {
      return { valid: true, status: res.status };
    }
    return { valid: false, status: res.status };
  } catch (e) {
    if (e.message.includes('404')) return { valid: false, status: 404 };
    return { valid: true, status: 'Error (Assume valid)' }; 
  }
}

async function main() {
  const force = process.argv.includes('--force');
  console.log('Starting Hugging Face Repository Validation...');
  if (force) console.log('  [!] Force mode enabled: checking all IDs regardless of cache.\n');
  else console.log('  [i] Using cache: only checking IDs not validated in the last 30 days.\n');
  
  const data = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
  const hfIdToModels = new Map();
  const hfIdMeta = new Map(); // Store metadata (validated_at, status)
  
  data.providers.forEach(p => {
    p.models.forEach(m => {
      if (m.hf_id) {
        if (!hfIdToModels.has(m.hf_id)) hfIdToModels.set(m.hf_id, []);
        hfIdToModels.get(m.hf_id).push(`${p.name}: ${m.name}`);
        
        // Cache metadata if present
        if (m.hf_validated_at && m.hf_status === 200) {
          const existing = hfIdMeta.get(m.hf_id);
          if (!existing || new Date(m.hf_validated_at) > new Date(existing.at)) {
            hfIdMeta.set(m.hf_id, { at: m.hf_validated_at, status: m.hf_status });
          }
        }
      }
    });
  });

  const ids = Array.from(hfIdToModels.keys());
  console.log(`Found ${ids.length} unique HF IDs to validate.\n`);
  
  const invalidIds = new Set();
  const now = new Date();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  
  const validationResults = new Map(); // id -> { status, at }

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const progress = `[${i + 1}/${ids.length}]`.padEnd(10);
    
    const cached = hfIdMeta.get(id);
    const isRecent = cached && (now - new Date(cached.at) < THIRTY_DAYS_MS);
    
    if (isRecent && !force) {
      console.log(`${progress} ≈ CACHED  (${cached.status}) ${id} (last checked ${new Date(cached.at).toLocaleDateString()})`);
      validationResults.set(id, { status: cached.status, at: cached.at });
      continue;
    }

    const check = await checkHfId(id);
    validationResults.set(id, { status: typeof check.status === 'number' ? check.status : 200, at: now.toISOString() });

    if (check.valid) {
      console.log(`${progress} ✓ VALID   (${check.status}) ${id}`);
    } else {
      console.log(`${progress} ✗ INVALID (${check.status}) ${id}`);
      console.log(`          Used by: ${hfIdToModels.get(id).join(', ')}`);
      invalidIds.add(id);
    }

    // Small delay to prevent rate limiting
    await new Promise(r => setTimeout(r, 50));
  }

  console.log('\nUpdating providers.json with validation results...');
  let updatedCount = 0;
  let removalCount = 0;
  
  data.providers.forEach(p => {
    p.models.forEach(m => {
      if (m.hf_id) {
        const res = validationResults.get(m.hf_id);
        if (invalidIds.has(m.hf_id)) {
          delete m.hf_id;
          delete m.hf_validated_at;
          delete m.hf_status;
          removalCount++;
        } else if (res) {
          m.hf_validated_at = res.at;
          m.hf_status = res.status;
          updatedCount++;
        }
      }
    });
  });

  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(data, null, 2));
  console.log(`Done. Updated ${updatedCount} models, removed ${removalCount} invalid IDs.`);
}

main().catch(err => {
  console.error('\nFatal error during validation:', err);
  process.exit(1);
});
