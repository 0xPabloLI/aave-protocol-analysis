import { Router } from 'express';
import { getCampaignForecastStates } from '../controllers/merklForecastController.js';

const router = Router();

router.get('/forecast-states', getCampaignForecastStates);

export default router;
