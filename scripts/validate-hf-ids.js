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
  console.log('Starting Hugging Face Repository Validation...\n');
  
  const data = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
  const hfIdToModels = new Map();
  
  data.providers.forEach(p => {
    p.models.forEach(m => {
      if (m.hf_id) {
        if (!hfIdToModels.has(m.hf_id)) hfIdToModels.set(m.hf_id, []);
        hfIdToModels.get(m.hf_id).push(`${p.name}: ${m.name}`);
      }
    });
  });

  const ids = Array.from(hfIdToModels.keys());
  console.log(`Found ${ids.length} unique HF IDs to validate across all providers.\n`);
  
  const invalidIds = new Set();
  const results = {
    valid: 0,
    invalid: 0,
    errors: 0
  };

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const progress = `[${i + 1}/${ids.length}]`.padEnd(10);
    
    const check = await checkHfId(id);
    
    if (check.valid) {
      results.valid++;
      console.log(`${progress} ✓ VALID   (${check.status}) ${id}`);
    } else {
      results.invalid++;
      console.log(`${progress} ✗ INVALID (${check.status}) ${id}`);
      console.log(`          Used by: ${hfIdToModels.get(id).join(', ')}`);
      invalidIds.add(id);
    }

    // Small delay to prevent rate limiting
    await new Promise(r => setTimeout(r, 50));
  }

  console.log('\n' + '='.repeat(50));
  console.log('VALIDATION SUMMARY');
  console.log('='.repeat(50));
  console.log(`Total Unique IDs:  ${ids.length}`);
  console.log(`Valid IDs:         ${results.valid}`);
  console.log(`Invalid (404s):    ${results.invalid}`);
  console.log('='.repeat(50));

  if (invalidIds.size > 0) {
    console.log(`\nAction: Removing ${invalidIds.size} invalid HF IDs from providers.json...`);
    let removalCount = 0;
    data.providers.forEach(p => {
      p.models.forEach(m => {
        if (m.hf_id && invalidIds.has(m.hf_id)) {
          delete m.hf_id;
          removalCount++;
        }
      });
    });
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(data, null, 2));
    console.log(`Successfully removed ${removalCount} occurrences.`);
  } else {
    console.log('\nSuccess: All checked HF IDs exist on Hugging Face.');
  }
}

main().catch(err => {
  console.error('\nFatal error during validation:', err);
  process.exit(1);
});
