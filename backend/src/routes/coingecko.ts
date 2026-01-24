import { Router } from 'express';
import { getCoingeckoCategories } from '../controllers/coingeckoController.js';

const router = Router();

router.get('/', getCoingeckoCategories);

export default router;
