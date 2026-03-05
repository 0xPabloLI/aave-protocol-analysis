import { Router } from 'express';
import { getRateInputs } from '../controllers/rateInputsController.js';

const router = Router();

router.get('/', getRateInputs);

export default router;
