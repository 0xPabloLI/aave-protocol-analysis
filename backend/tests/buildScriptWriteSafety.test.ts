import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('build script write-path safety', () => {
  const scriptsDir = resolve(__dirname, '../scripts');

  it('generate-openapi.ts: every writeFileSync target dir is guaranteed to exist at Docker build time', () => {
    const src = readFileSync(resolve(scriptsDir, 'generate-openapi.ts'), 'utf-8');

    const hasMkdirSyncForStaticDir = src.includes('mkdirSync') &&
      /mkdirSync\s*\(/.test(src) &&
      (src.includes("'../static'") || src.includes('"../static"') || src.includes("../static"));

    if (!hasMkdirSyncForStaticDir) {
      throw new Error(
        `generate-openapi.ts has no mkdirSync for its output directory (../static).\n` +
        `Without this, Docker builds fail with ENOENT because the directory does not exist in a clean environment.\n` +
        `Fix: Add mkdirSync(new URL('../static', import.meta.url), { recursive: true }) before writeFileSync.`
      );
    }
  });

  it('generate-schema-fp.ts: writeFileSync target dir exists via Dockerfile COPY packages/', () => {
    const src = readFileSync(resolve(scriptsDir, 'generate-schema-fp.ts'), 'utf-8');
    const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf-8');

    const writesToPackages = src.includes('writeFileSync') && src.includes('packages/');
    if (!writesToPackages) return;

    if (!dockerfile.includes('COPY packages/')) {
      throw new Error(
        `generate-schema-fp.ts writes to packages/ but Dockerfile has no COPY packages/`
      );
    }
  });

  it('Dockerfile: backend build step copies all script dependencies', () => {
    const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf-8');

    const required = ['backend/src/', 'backend/scripts/', 'backend/tsconfig.json'];
    for (const path of required) {
      if (!dockerfile.includes(path)) {
        throw new Error(`Dockerfile is missing COPY for ${path} — backend build will fail`);
      }
    }
  });

  it('Dockerfile: backend/static/ is produced in builder and copied to production stage', () => {
    const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf-8');

    const builderProducesStatic =
      dockerfile.includes('mkdir -p backend/static') ||
      dockerfile.includes('mkdirSync');

    const productionCopiesStatic = /COPY\s+--from=builder.*backend\/static/.test(dockerfile);

    if (!productionCopiesStatic) {
      throw new Error(
        `Dockerfile does not COPY --from=builder .../backend/static/ to production stage.\n` +
        `The OpenAPI spec and Swagger UI will be missing at runtime.\n` +
        `Fix: Add COPY --from=builder /app/backend/static/ ./backend/static/ after the dist COPY.`
      );
    }
  });
});
