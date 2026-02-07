import { Router } from 'express';
import { getCampaignForecastState, getCampaignForecastStates } from '../controllers/merklForecastController.js';

const router = Router();

router.get('/forecast-states', getCampaignForecastStates);
router.get('/:campaignId/forecast-state', getCampaignForecastState);

export default router;
