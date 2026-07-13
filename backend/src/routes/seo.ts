import { Router } from 'express';
import { seoAuthMiddleware } from '../middleware/seoAuth.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';
import {
  getSeoStatus,
  getGscData,
  triggerGscFetch,
  listGscSites,
  getSemrushSnapshots,
  upsertSemrushSnapshot,
  batchUpsertSemrushSnapshots,
  deleteSemrushSnapshot,
} from '../controllers/seoController.js';
import { getPersistenceStatus } from '../services/persistenceService.js';

const router = Router();

router.use(seoAuthMiddleware);
router.use(rateLimitMiddleware(10 * 60_000, 100));

router.get('/status', getSeoStatus);
router.get('/gsc', getGscData);
router.post('/gsc/trigger', triggerGscFetch);
router.get('/gsc/sites', listGscSites);
router.get('/semrush', getSemrushSnapshots);
router.post('/semrush', upsertSemrushSnapshot);
router.post('/semrush/batch', batchUpsertSemrushSnapshots);
router.delete('/semrush/:id', deleteSemrushSnapshot);
router.get('/persistence-status', (_req, res) => {
  res.json(getPersistenceStatus());
});

export const seoRouter = router;
