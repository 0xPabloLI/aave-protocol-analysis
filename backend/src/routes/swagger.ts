import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';

const router = Router();

const STATIC_DIR = path.resolve(import.meta.dirname, '../../static');

router.use(rateLimitMiddleware(10 * 60_000, 200));

router.get('/', async (_req, res) => {
  const html = await fs.readFile(path.join(STATIC_DIR, 'swagger.html'), 'utf-8');
  res.type('html').send(html);
});

router.get('/openapi.json', async (_req, res) => {
  const json = await fs.readFile(path.join(STATIC_DIR, 'openapi.json'), 'utf-8');
  res.type('json').send(json);
});

export { router as swaggerRouter };
