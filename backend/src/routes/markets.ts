import { Router } from 'express';
import {
  getMarkets,
  getStats,
  getChains,
  getMarketsList,
  refreshMarkets,
} from '../controllers/marketsController.js';

const router = Router();

router.get('/', getMarkets);
router.get('/stats', getStats);
router.post('/refresh', refreshMarkets);
router.get('/chains', getChains);
router.get('/list', getMarketsList);

export default router;

