import express, { Request, Response } from 'express';
import { query } from '../db.js';
import { verifyUserToken } from './auth.js';
import { distributeDataForDist } from '../distributor.js';

const router = express.Router();

router.use(verifyUserToken);

// Get all distributions
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    let result;
    
    if (user.role === 'ADMIN') {
      result = await query(`
        SELECT d.*
        FROM data_distributions d
        ORDER BY d.created_at DESC
      `);
    } else {
      const pIds = user.project_ids || [];
      if (pIds.length === 0) {
        return res.json({ success: true, data: [] });
      }
      
      const allProjects = await query('SELECT id, parent_id FROM projects');
      const isAllowed = (pId: number): boolean => {
        if (pIds.includes(pId)) return true;
        const p = allProjects.rows.find(x => x.id === pId);
        if (p && p.parent_id) return isAllowed(p.parent_id);
        return false;
      };
      
      const allowedPIds = allProjects.rows.filter(p => isAllowed(p.id)).map(p => p.id);
      
      if (allowedPIds.length === 0) {
        return res.json({ success: true, data: [] });
      }

      result = await query(`
        SELECT d.*
        FROM data_distributions d
        WHERE d.project_ids && $1::int[]
        ORDER BY d.created_at DESC
      `, [allowedPIds]);
    }
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching distributions:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch distributions' });
  }
});

// Create a new distribution
router.post('/', async (req: Request, res: Response) => {
  const { name, project_ids, source_data_info, target_db_type, target_db_config, status, start_time } = req.body;
  try {
    const defaultStatus = status || 'ACTIVE';
    const isStarting = defaultStatus === 'ACTIVE';
    const hasStart = !!start_time;
    const text = `INSERT INTO data_distributions 
      (name, project_ids, source_data_info, target_db_type, target_db_config, status, start_time) 
      VALUES ($1, $2, $3, $4, $5, $6, ${hasStart ? '$7' : (isStarting ? 'CURRENT_TIMESTAMP' : 'NULL')}) RETURNING *`;
    const params: any[] = [name, project_ids || [], source_data_info, target_db_type, target_db_config, defaultStatus];
    if (hasStart) params.push(new Date(start_time));
    const result = await query(text, params);
    res.json({ success: true, message: 'Distribution created', data: result.rows[0] });
  } catch (error) {
    console.error('Error creating distribution:', error);
    res.status(500).json({ success: false, error: 'Failed to create distribution' });
  }
});

// Update a distribution status
router.put('/:id/status', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    // Only update status and updated_at. Do NOT override start_time with CURRENT_TIMESTAMP here,
    // otherwise the manually set start_time will be lost when starting the distribution.
    const result = await query(
      `UPDATE data_distributions 
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [status, parseInt(id, 10)]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Distribution not found' });
    }
    res.json({ success: true, message: `Distribution ${status === 'ACTIVE' ? 'started' : 'stopped'}`, data: result.rows[0] });
  } catch (error) {
    console.error('Error updating distribution status:', error);
    res.status(500).json({ success: false, error: 'Failed to update distribution status' });
  }
});

// Update a distribution
router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, project_ids, source_data_info, target_db_type, target_db_config, status, start_time } = req.body;
  try {
    const prevDist = await query('SELECT status FROM data_distributions WHERE id = $1', [parseInt(id, 10)]);
    if (prevDist.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Distribution not found' });
    }
    
    const wasActive = prevDist.rows[0].status === 'ACTIVE';
    const isNowActive = status === 'ACTIVE';
    let startTimeUpdate = '';
    const params: any[] = [name, project_ids || [], source_data_info, target_db_type, target_db_config, status];
    if (start_time !== undefined && start_time !== null && start_time !== '') {
      startTimeUpdate = ', start_time = $7';
      params.push(new Date(start_time));
    } else {
      startTimeUpdate = ', start_time = NULL';
    }

    params.push(parseInt(id, 10));
    const text = `UPDATE data_distributions 
      SET name = $1, project_ids = $2, source_data_info = $3, target_db_type = $4, target_db_config = $5, status = $6, updated_at = CURRENT_TIMESTAMP${startTimeUpdate}
      WHERE id = $${params.length} RETURNING *`;
    const result = await query(text, params);
    
    res.json({ success: true, message: 'Distribution updated', data: result.rows[0] });
  } catch (error) {
    console.error('Error updating distribution:', error);
    res.status(500).json({ success: false, error: 'Failed to update distribution' });
  }
});

// Set custom start time (补发开始时间)
router.put('/:id/start-time', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { start_time } = req.body as { start_time?: string };
  try {
    if (!start_time) {
      return res.status(400).json({ success: false, error: 'start_time 必填' });
    }
    const result = await query(
      `UPDATE data_distributions SET start_time = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [new Date(start_time), parseInt(id, 10)]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Distribution not found' });
    }
    res.json({ success: true, message: 'Start time updated', data: result.rows[0] });
  } catch (error) {
    console.error('Error updating start time:', error);
    res.status(500).json({ success: false, error: 'Failed to update start time' });
  }
});

// Delete a distribution
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await query('DELETE FROM data_distributions WHERE id = $1', [parseInt(id, 10)]);
    res.json({ success: true, message: 'Distribution deleted' });
  } catch (error) {
    console.error('Error deleting distribution:', error);
    res.status(500).json({ success: false, error: 'Failed to delete distribution' });
  }
});

// Replay (补发) historical data for a distribution
router.post('/:id/replay', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { start, end } = req.body as { start: string; end?: string };
  try {
    const distRes = await query(`SELECT id, project_ids FROM data_distributions WHERE id = $1`, [parseInt(id, 10)]);
    if (distRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Distribution not found' });
    }
    const dist = distRes.rows[0] as { id: number; project_ids: number[] };
    const startTime = new Date(start);
    if (!startTime || isNaN(startTime.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid start time' });
    }
    const endTime = end ? new Date(end) : new Date();
    if (isNaN(endTime.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid end time' });
    }
    if (startTime > endTime) {
      return res.status(400).json({ success: false, error: 'start must be earlier than end' });
    }

    // 立即响应前端，防止等待时间过长导致网络超时
    res.json({ success: true, message: 'Replay task started in background' });

    // 在后台异步处理数据重扫，防止接口阻塞
    (async () => {
      try {
        const limit = 1000;
        let offset = 0;
        while (true) {
          const rowsRes = await query(
            `
            SELECT t.gateway_sncode, t.insname, t.propertyno, t.value, t.ts,
                   COALESCE(t.project_id, g.project_id) AS project_id
            FROM telemetry_data t
            LEFT JOIN gateway_info g ON t.gateway_sncode = g.sncode
            WHERE (t.project_id = ANY($1::int[])
                   OR (t.project_id IS NULL AND g.project_id = ANY($1::int[])))
              AND t.ts >= $2 AND t.ts <= $3
            ORDER BY t.ts ASC, t.id ASC
            LIMIT $4 OFFSET $5
            `,
            [dist.project_ids, startTime.toISOString(), endTime.toISOString(), limit, offset]
          ).catch(() => ({ rowCount: 0, rows: [] as any[] } as any));
          
          if (!rowsRes || rowsRes.rowCount === 0) break;
          for (const row of rowsRes.rows) {
            await distributeDataForDist(
              dist.id,
              row.gateway_sncode,
              [{ insname: row.insname, propertyno: row.propertyno, value: row.value }],
              new Date(row.ts),
              Number(row.project_id)
            );
          }
          if (rowsRes.rowCount < limit) break;
          offset += limit;
        }
        console.log(`[Replay] Background replay task for distribution ${dist.id} completed successfully.`);
      } catch (err) {
        console.error(`[Replay] Background replay task for distribution ${dist.id} failed:`, err);
      }
    })();

  } catch (error) {
    console.error('Error initiating replay distribution:', error);
    res.status(500).json({ success: false, error: 'Failed to initiate replay distribution' });
  }
});

export default router;
