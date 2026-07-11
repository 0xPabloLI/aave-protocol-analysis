import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const PKG_PATH = join(ROOT, 'node_modules', 'ethers', 'package.json');

try {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));

  if (pkg.version !== '5.8.0') {
    process.exit(0);
  }

  const exports = pkg.exports;
  const patch = {
    '.': { 'default': './lib/index.js' },
    './lib/*': { 'default': './lib/*.js' },
  };

  if (!exports ||
      JSON.stringify(exports['.']) !== JSON.stringify(patch['.']) ||
      JSON.stringify(exports['./lib/*']) !== JSON.stringify(patch['./lib/*'])) {
    pkg.exports = patch;
    writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  }
} catch {
  // ethers not installed yet — silently skip
}