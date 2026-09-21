/**
 * Standalone E2E Test Suite Runner for Telegram Content Publisher Bot MVP.
 * Runs all test tiers (Tier 1 to Tier 4) and outputs structured test execution results.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testFiles = [
  join(__dirname, 'tier1-feature-coverage.spec.ts'),
  join(__dirname, 'tier2-boundary-cases.spec.ts'),
  join(__dirname, 'tier3-cross-feature.spec.ts'),
  join(__dirname, 'tier4-application-scenarios.spec.ts'),
];

console.log('================================================================');
console.log('🚀 Running Telegram Content Publisher Bot E2E Test Suite');
console.log('   Tiers 1-4 (Opaque-Box Hermetic Verification)');
console.log('================================================================\n');

const child = spawn(
  process.execPath,
  ['--test', '--experimental-strip-types', ...testFiles],
  {
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  },
);

child.on('exit', (code) => {
  console.log('\n================================================================');
  if (code === 0) {
    console.log('✅ ALL E2E TEST TIERS PASSED (100% SUCCESS)');
  } else {
    console.error(`❌ E2E TEST RUN FAILED with exit code ${code}`);
  }
  console.log('================================================================');
  process.exit(code ?? 1);
});
