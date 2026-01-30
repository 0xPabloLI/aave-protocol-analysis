import { Router } from 'express';
import { getCoingeckoFdv } from '../controllers/coingeckoController.js';

const router = Router();

router.get('/', getCoingeckoFdv);

export default router;
