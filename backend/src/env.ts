import dotenv from 'dotenv';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

// Railway injects env vars natively — no .env needed
if (process.env.RAILWAY_ENVIRONMENT) {
  console.log(`🚂 Railway environment detected (${process.env.RAILWAY_ENVIRONMENT}), using injected env vars`);
} else {
  // 1) Load repo-root .env FIRST (BEFORE @internal/aave-shared-config is imported anywhere)
  //    This is critical: shared-config reads process.env.INFURA_PROJECT_ID etc. at module top-level.
  //    If shared-config evaluates before dotenv, private RPC keys are forever undefined.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const repoRoot = resolve(__dirname, '..', '..');
  const envPath = join(repoRoot, '.env');

  console.log(`📄 Loading .env file: ${envPath}`);
  dotenv.config({ path: envPath });
  console.log('✅ Loaded environment variables from .env file');

  // 2) Optionally try Doppler (production secret manager, won't overwrite already-set env vars)
  try {
    const { tryLoadFromDoppler } = await import('@internal/aave-shared-config');
    tryLoadFromDoppler();
  } catch {
    // Doppler not available — .env fallback is sufficient for local dev
  }
}
