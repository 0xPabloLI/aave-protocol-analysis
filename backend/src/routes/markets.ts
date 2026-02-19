import { Router } from 'express';
import {
  getMarkets,
  getChains,
  getMarketsList,
} from '../controllers/marketsController.js';

const router = Router();

router.get('/', getMarkets);
router.get('/chains', getChains);
router.get('/list', getMarketsList);

// 移除专用的 /refresh 端点
// 所有数据刷新都通过常规 API 请求自动触发

export default router;
