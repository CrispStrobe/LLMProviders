'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SPACE_YML = path.join(ROOT, '.huggingface', 'space.yml');
const README = path.join(ROOT, 'README.md');

function run(cmd) {
  console.log(`> ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

async function main() {
  console.log('Syncing to Hugging Face Space...');

  if (!fs.existsSync(SPACE_YML)) {
    console.error('Error: .huggingface/space.yml not found');
    process.exit(1);
  }

  // 1. Create the HF version of README
  const metadata = fs.readFileSync(SPACE_YML, 'utf8');
  const content = fs.readFileSync(README, 'utf8');
  fs.writeFileSync(README, metadata + '\n' + content);

  try {
    // 2. Commit and Push
    run('git add README.md');
    run('git commit -m "chore: sync to Hugging Face with metadata [skip ci]"');
    run('git push hf main --force');
    console.log('\n✓ Successfully pushed to Hugging Face Space.');
  } catch (err) {
    console.error('\n✗ Failed to push to Hugging Face.');
  } finally {
    // 3. Revert the local commit and README change
    console.log('\nRestoring local README...');
    run('git reset --hard HEAD~1');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
