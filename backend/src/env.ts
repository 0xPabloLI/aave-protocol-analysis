import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseEnvLinesToObject, injectEnv, tryLoadFromDoppler } from '@internal/aave-shared-config';

// Railway injects env vars natively — no Doppler or .env needed
if (process.env.RAILWAY_ENVIRONMENT) {
  console.log(`🚂 Railway environment detected (${process.env.RAILWAY_ENVIRONMENT}), using injected env vars`);
} else {
  // 1) Prefer Secret Manager (Doppler) at runtime (no .env on server required)
  const didLoadFromSecretManager = tryLoadFromDoppler();

  // 2) Fallback: Unified env loading from repo-root `.env` (dev/local)
  if (!didLoadFromSecretManager) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    // backend/src → backend → repo root
    const repoRoot = resolve(__dirname, '..', '..');
    const envPath = join(repoRoot, '.env');

    console.log(`📄 Falling back to .env file: ${envPath}`);
    dotenv.config({ path: envPath });
    console.log('✅ Loaded environment variables from .env file');
  }
}

