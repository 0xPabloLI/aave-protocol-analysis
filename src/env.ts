import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

function parseEnvLinesToObject(envText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function injectEnv(envVars: Record<string, string>): void {
  for (const [key, value] of Object.entries(envVars)) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

function tryLoadFromDoppler(): boolean {
  if (!process.env.DOPPLER_TOKEN) return false;

  try {
    const envText = execSync('doppler secrets download --no-file --format env', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const envVars = parseEnvLinesToObject(envText);
    injectEnv(envVars);
    return true;
  } catch {
    return false;
  }
}

// 1) Prefer Secret Manager (Doppler) at runtime (no .env on server required)
const didLoadFromSecretManager = tryLoadFromDoppler();

// 2) Fallback: repo-root `.env` (dev/local)
if (!didLoadFromSecretManager) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const repoRoot = resolve(__dirname, '..');
  const envPath = join(repoRoot, '.env');
  dotenv.config({ path: envPath });
}

