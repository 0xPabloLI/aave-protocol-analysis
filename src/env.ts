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
  // Check for DOPPLER_TOKEN in environment or Doppler config
  // Doppler CLI can use token from:
  // 1. DOPPLER_TOKEN environment variable
  // 2. Doppler config file (if doppler setup was run)
  const dopplerToken = process.env.DOPPLER_TOKEN;
  
  if (!dopplerToken) {
    console.log('ℹ️  DOPPLER_TOKEN not set in process environment');
    console.log('   💡 Checking if Doppler CLI is configured...');
    
    // Try to check if doppler is configured (might have token in config)
    try {
      execSync('doppler configure get token --plain', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.log('   ✅ Doppler CLI is configured (using config file token)');
    } catch {
      console.log('   ⚠️  Doppler CLI is not configured');
      console.log('   💡 To configure: doppler setup');
      console.log('   💡 Or set DOPPLER_TOKEN environment variable');
      return false;
    }
  } else {
    // Only show first few chars of token for security
    const tokenPrefix = dopplerToken.substring(0, 10);
    console.log(`✅ DOPPLER_TOKEN found in environment (prefix: ${tokenPrefix}...)`);
  }

  try {
    console.log('🔍 Attempting to fetch secrets from Doppler...');
    
    // Ensure DOPPLER_TOKEN is available to doppler CLI
    const env = dopplerToken ? { ...process.env, DOPPLER_TOKEN: dopplerToken } : process.env;
    
    const envText = execSync('doppler secrets download --no-file --format env', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env,
    });
    const envVars = parseEnvLinesToObject(envText);
    const envVarKeys = Object.keys(envVars);
    
    if (envVarKeys.length === 0) {
      console.log('⚠️  Doppler returned no environment variables');
      console.log('   💡 Check your Doppler project configuration');
      return false;
    }
    
    injectEnv(envVars);
    console.log(`✅ Successfully loaded ${envVarKeys.length} environment variable(s) from Doppler`);
    console.log(`   Variables loaded: ${envVarKeys.join(', ')}`);
    
    // Check for critical variables
    const criticalVars = ['CLOUDFLARE_WORKER_URL'];
    const missingCritical = criticalVars.filter(v => !process.env[v]);
    if (missingCritical.length > 0) {
      console.log(`⚠️  Warning: Critical environment variables not found in Doppler: ${missingCritical.join(', ')}`);
      console.log(`   💡 Please add these variables to your Doppler project`);
    }
    
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`❌ Failed to fetch secrets from Doppler: ${errorMessage}`);
    
    // Provide helpful error messages
    if (errorMessage.includes('token') || errorMessage.includes('authentication')) {
      console.log('   💡 This might be a token authentication issue');
      console.log('   💡 Verify DOPPLER_TOKEN is correct and has proper permissions');
    } else if (errorMessage.includes('project') || errorMessage.includes('config')) {
      console.log('   💡 This might be a Doppler project configuration issue');
      console.log('   💡 Run: doppler setup');
    }
    
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
  
  console.log(`📄 Falling back to .env file: ${envPath}`);
  dotenv.config({ path: envPath });
  console.log('✅ Loaded environment variables from .env file');
}

