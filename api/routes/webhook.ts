import express, { Request, Response } from 'express';
import { ingestData } from '../ingestor.js';

const router = express.Router();

/**
 * Handle V3/V4 Data Push Webhook from AG Gateway
 * Body example:
 * {
 *   "time": 1767018681,
 *   "sncode": "1312690CC87717F4",
 *   "dev": {
 *       "694e9d0f": [
 *           { "pn": "tag1", "q": 1, "v": "20.90" }
 *       ]
 *   }
 * }
 */
router.post('/ingest', async (req: Request, res: Response) => {
  const payload = req.body;
  
  if (!payload || !payload.sncode || !payload.dev) {
    return res.status(400).json({ success: false, error: 'Invalid payload format' });
  }

  const { time, sncode, dev } = payload;

  try {
    await ingestData(sncode, dev, time);
    res.status(200).json({ success: true, message: 'Data ingested successfully' });
  } catch (error) {
    console.error('Ingestion error:', error);
    res.status(500).json({ success: false, error: 'Failed to ingest data' });
  }
});

export default router;