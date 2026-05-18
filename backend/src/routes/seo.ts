import { Router } from 'express';
import { seoAuthMiddleware } from '../middleware/seoAuth.js';
import {
  getSeoStatus,
  getGscData,
  getSemrushSnapshots,
  upsertSemrushSnapshot,
  batchUpsertSemrushSnapshots,
  deleteSemrushSnapshot,
} from '../controllers/seoController.js';

const router = Router();

router.use(seoAuthMiddleware);
router.get('/status', getSeoStatus);
router.get('/gsc', getGscData);
router.get('/semrush', getSemrushSnapshots);
router.post('/semrush', upsertSemrushSnapshot);
router.post('/semrush/batch', batchUpsertSemrushSnapshots);
router.delete('/semrush/:id', deleteSemrushSnapshot);

export const seoRouter = router;
