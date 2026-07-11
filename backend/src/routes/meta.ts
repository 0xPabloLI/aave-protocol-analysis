import { Router } from 'express';
import { getSideDataMeta } from '../controllers/metaController.js';

const router = Router();

router.get('/side-data', getSideDataMeta);

export default router;

