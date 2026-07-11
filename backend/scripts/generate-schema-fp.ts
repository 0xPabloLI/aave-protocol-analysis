#!/usr/bin/env npx tsx
/**
 * Generate schema-fingerprint.ts for the shared-config package.
 *
 * Computes the current API response shape fingerprint and writes it
 * to packages/aave-shared-config/schema-fingerprint.ts so both the
 * backend and the frontend have a single source of truth for cache
 * invalidation.
 *
 * Usage: npx tsx backend/scripts/generate-schema-fp.ts
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSchemaFingerprint } from '../src/services/marketsApiSerialize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fp = computeSchemaFingerprint();

const content = [
  '// GENERATED FILE — do not edit manually.',
  '// Run: npx tsx backend/scripts/generate-schema-fp.ts',
  `export const SCHEMA_FP = '${fp}';`,
  '',
].join('\n');

// Write to shared-config package (for backend consumption)
const sharedConfigPath = resolve(__dirname, '../../packages/aave-shared-config/schema-fingerprint.ts');
writeFileSync(sharedConfigPath, content, 'utf-8');

// Also print for frontend sync
console.log(`SCHEMA_FP=${fp}`);
console.log(`Written to ${sharedConfigPath}`);
console.log('');
console.log('→ If this changed, update the frontend file:');
console.log('  aaveapy/src/shared/schema-fingerprint.ts');