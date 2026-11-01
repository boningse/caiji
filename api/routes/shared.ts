import express, { Request, Response, NextFunction } from 'express';
import { query } from '../db.js';
import { getMqttClient } from '../mqtt.js';
import { ensureEnvironmentMonitorSchema } from '../environment-monitor.js';

const router = express.Router();

// Middleware to verify API token
const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, code: 401, error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];
  
  try {
    const result = await query("SELECT * FROM api_tokens WHERE token = $1 AND status = 'ACTIVE'", [token]);
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, code: 401, error: 'Unauthorized: Invalid or inactive token' });
    }
    
    // Attach token info to request for later use
    (req as any).apiToken = result.rows[0];
    next();
  } catch (error) {
    console.error('Error verifying token:', error);
    res.status(500).json({ success: false, code: 500, error: 'Internal server error' });
  }
};

// Apply middleware to all routes in this router
router.use(verifyToken);

// Middleware to check permissions
const requirePermission = (perm: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const tokenInfo = (req as any).apiToken;
    const permissions = tokenInfo.permissions || [];
    if (!permissions.includes(perm)) {
      return res.status(403).json({ success: false, code: 403, error: `Forbidden: Missing '${perm}' permission` });
    }
    next();
  };
};

const queryText = (value: unknown, maxLength: number) => {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, maxLength);
};

// Read the latest cumulative energy register for one configured meter point.
// This endpoint is intended for server-to-server billing integrations and uses
// the same project-scoped API token as the generic shared telemetry endpoint.
router.get('/meter-reading', requirePermission('read_data'), async (req: Request, res: Response) => {
  try {
    const tokenInfo = (req as any).apiToken;
    const projectIds: number[] = (tokenInfo.project_ids || []).map(Number).filter(Number.isFinite);
    const deviceCode = queryText(req.query.deviceCode ?? req.query.meterId, 128);
    const propertyno = queryText(req.query.propertyno ?? req.query.propertyNo, 64);
    const insname = queryText(req.query.insname, 128);
    const projectCode = queryText(req.query.projectCode, 64);

    if (!deviceCode) {
      return res.status(400).json({ success: false, code: 400, error: 'deviceCode is required' });
    }
    if (!propertyno) {
      return res.status(400).json({ success: false, code: 400, error: 'propertyno is required' });
    }

    const params: any[] = [];
    const conditions: string[] = [];
    if (projectIds.length > 0) {
      params.push(projectIds);
      // Telemetry is physically copied once for each bound project. Query the
      // token's exact projects so a parent token does not also receive the
      // identical child-project copies. The second branch keeps legacy rows
      // written before telemetry_data.project_id existed readable.
      conditions.push('(t.project_id = ANY($1::int[]) OR (t.project_id IS NULL AND g.project_id = ANY($1::int[])))');
    }

    params.push(deviceCode);
    conditions.push(`t.device_code = $${params.length}`);
    params.push(propertyno);
    conditions.push(`t.propertyno = $${params.length}`);
    if (insname) {
      params.push(insname);
      conditions.push(`BTRIM(COALESCE(t.insname, '')) = $${params.length}`);
    }
    if (projectCode) {
      params.push(projectCode);
      conditions.push(`BTRIM(COALESCE(p.code, '')) = $${params.length}`);
    }

    const result = await query(`
      SELECT t.id, t.device_code, t.point_name, t.insname, t.propertyno, t.paraname,
        t.quality, t.value, t.ts, p.id AS project_id, p.code AS project_code, p.name AS project_name
      FROM telemetry_data t
      LEFT JOIN gateway_info g ON t.gateway_sncode = g.sncode
      LEFT JOIN projects p ON COALESCE(t.project_id, g.project_id) = p.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.ts DESC, t.id DESC
      LIMIT 1`, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, code: 404, error: 'Meter reading not found' });
    }

    const row = result.rows[0];
    const totalKwh = Number(row.value);
    if (!Number.isFinite(totalKwh) || totalKwh < 0) {
      return res.status(422).json({ success: false, code: 422, error: 'Latest meter reading is not a valid cumulative energy value' });
    }

    return res.json({
      success: true,
      code: 0,
      data: {
        meterId: row.device_code,
        totalKwh,
        readingAt: row.ts,
        quality: row.quality,
        pointName: row.point_name,
        insname: row.insname,
        propertyNo: row.propertyno,
        parameterName: row.paraname,
        projectId: row.project_id,
        projectCode: row.project_code,
        projectName: row.project_name
      }
    });
  } catch (error) {
    console.error('Error fetching shared meter reading:', error);
    return res.status(500).json({ success: false, code: 500, error: 'Failed to fetch meter reading' });
  }
});

// Get shared telemetry data based on token permissions
router.get('/telemetry', requirePermission('read_data'), async (req: Request, res: Response) => {
  try {
    const tokenInfo = (req as any).apiToken;
    const projectIds: number[] = tokenInfo.project_ids || [];
    const { start, end, limit } = req.query as { start?: string; end?: string; limit?: string };
    const useTodayLatestPerPoint = !start && !end && !limit;

    // Parse time range if provided
    let startDate: Date | null = null;
    let endDate: Date | null = null;
    if (start) {
      const s = new Date(start);
      if (isNaN(s.getTime())) {
        return res.status(400).json({ success: false, code: 400, error: 'Invalid start time format' });
      }
      startDate = s;
    }
    if (end) {
      const e = new Date(end);
      if (isNaN(e.getTime())) {
        return res.status(400).json({ success: false, code: 400, error: 'Invalid end time format' });
      }
      endDate = e;
    }
    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({ success: false, code: 400, error: 'start must be earlier than end' });
    }
    const rowLimit = Math.min(Math.max(parseInt(limit || '0', 10) || (startDate || endDate ? 5000 : 500), 1), 20000);
    
    const queryParams: any[] = [];
    let sql = `
      SELECT t.id, t.gateway_sncode, t.device_code, t.point_id, t.point_name, t.insname, t.propertyno, t.paraname, t.quality, t.value, t.ts,
             p.id as project_id, p.code as project_code, p.name as project_name
      FROM telemetry_data t
      LEFT JOIN gateway_info g ON t.gateway_sncode = g.sncode
      LEFT JOIN projects p ON COALESCE(t.project_id, g.project_id) = p.id
      `;

    const whereClauses: string[] = [];
    // If project_ids is empty, the token has global access. Otherwise query
    // only its exact physical project copies (plus legacy unscoped rows).
    if (projectIds.length > 0) {
      queryParams.push(projectIds);
      whereClauses.push('(t.project_id = ANY($1::int[]) OR (t.project_id IS NULL AND g.project_id = ANY($1::int[])))');
    }
    if (startDate) {
      whereClauses.push(`t.ts >= ($${queryParams.length + 1}::timestamptz AT TIME ZONE 'Asia/Shanghai')`);
      queryParams.push(startDate.toISOString());
    }
    if (endDate) {
      whereClauses.push(`t.ts <= ($${queryParams.length + 1}::timestamptz AT TIME ZONE 'Asia/Shanghai')`);
      queryParams.push(endDate.toISOString());
    }
    if (useTodayLatestPerPoint) {
      // With no filters, return today's newest reading for every project point.
      // telemetry_data.ts is a Shanghai wall-clock timestamp without a timezone.
      // Compare it to Shanghai wall-clock bounds directly; converting these
      // bounds back to timestamptz shifts them when the session timezone is UTC.
      whereClauses.push(`t.ts >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::timestamp)`);
      whereClauses.push(`t.ts < (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date + 1)::timestamp)`);
    }
    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    if (useTodayLatestPerPoint) {
      sql = `
        SELECT id, gateway_sncode, device_code, point_name, insname, propertyno, paraname, quality, value, ts,
               project_id, project_code, project_name
        FROM (
          SELECT telemetry_rows.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY project_id,
                     COALESCE('point:' || point_id::text,
                       'legacy:' || CONCAT_WS('|', COALESCE(gateway_sncode, ''), COALESCE(device_code, ''),
                         COALESCE(insname, ''), COALESCE(propertyno, ''), COALESCE(paraname, ''))),
                     BTRIM(COALESCE(propertyno, '')), BTRIM(COALESCE(paraname, ''))
                   ORDER BY ts DESC, id DESC
                 ) AS point_rank
          FROM (${sql}) telemetry_rows
        ) latest_points
        WHERE point_rank = 1
        ORDER BY ts DESC, id DESC`;
    } else {
      sql += ` ORDER BY t.ts DESC LIMIT ${rowLimit}`;
    }

    const result = await query(sql, queryParams);
    res.json({ success: true, code: 0, data: result.rows });
  } catch (error) {
    console.error('Error fetching shared telemetry data:', error);
    res.status(500).json({ success: false, code: 500, error: 'Failed to fetch data' });
  }
});

// Read environmental-monitoring data through the same shared API token and
// project scope as telemetry. Environmental readings live in their own
// hypertable, so they are intentionally exposed as a separate endpoint rather
// than changing the established /telemetry response format.
router.get('/environment-monitor', requirePermission('read_data'), async (req: Request, res: Response) => {
  try {
    await ensureEnvironmentMonitorSchema();
    const tokenInfo = (req as any).apiToken;
    const projectIds: number[] = (tokenInfo.project_ids || []).map(Number).filter(Number.isFinite);
    const { start, end, limit } = req.query as { start?: string; end?: string; limit?: string };
    const functionCode = queryText(req.query.functionCode, 64);
    const deviceAddr = queryText(req.query.deviceAddr, 32);
    const projectCode = queryText(req.query.projectCode, 64);

    let startDate: Date | null = null;
    let endDate: Date | null = null;
    if (start) {
      const parsed = new Date(start);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ success: false, code: 400, error: 'Invalid start time format' });
      startDate = parsed;
    }
    if (end) {
      const parsed = new Date(end);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ success: false, code: 400, error: 'Invalid end time format' });
      endDate = parsed;
    }
    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({ success: false, code: 400, error: 'start must be earlier than end' });
    }
    const rowLimit = Math.min(Math.max(parseInt(limit || '0', 10) || (startDate || endDate ? 5000 : 500), 1), 20000);
    const params: any[] = [];
    const where: string[] = [];

    if (projectIds.length > 0) {
      params.push(projectIds);
      where.push(`r.project_id IN (
        WITH RECURSIVE authorized_projects AS (
          SELECT id FROM projects WHERE id = ANY($${params.length}::int[])
          UNION
          SELECT p.id FROM projects p JOIN authorized_projects ap ON p.parent_id = ap.id
        )
        SELECT id FROM authorized_projects
      )`);
    }
    if (startDate) {
      params.push(startDate.toISOString());
      where.push(`r.sample_time >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate.toISOString());
      where.push(`r.sample_time <= $${params.length}`);
    }
    if (functionCode) {
      params.push(functionCode);
      where.push(`r.function_code = $${params.length}`);
    }
    if (deviceAddr) {
      params.push(deviceAddr);
      where.push(`r.device_addr::text = $${params.length}`);
    }
    if (projectCode) {
      params.push(projectCode);
      where.push(`BTRIM(COALESCE(p.code, '')) = $${params.length}`);
    }

    const baseSql = `
      SELECT r.id, r.project_id, p.code AS project_code, p.name AS project_name,
        r.group_id, r.device_addr, r.device_name, r.node_id, r.register_id,
        r.factor_id, r.factor_name, r.device_function_id, r.function_code,
        r.function_name, r.data_type, r.data_text, r.value, r.unit,
        r.alarm_level, r.alarm_color, r.alarm_info, r.sample_time, r.received_at
      FROM environment_monitor_readings r
      JOIN projects p ON p.id = r.project_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    `;
    const useTodayLatestPerPoint = !startDate && !endDate && !limit;
    const sql = useTodayLatestPerPoint
      ? `SELECT * FROM (
          SELECT environment_rows.*,
            ROW_NUMBER() OVER (
              PARTITION BY project_id, group_id, device_addr, node_id, register_id
              ORDER BY sample_time DESC, id DESC
            ) AS point_rank
          FROM (${baseSql}) environment_rows
          WHERE sample_time >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai')
            AND sample_time < (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
        ) latest_environment_rows
        WHERE point_rank = 1
        ORDER BY sample_time DESC, id DESC`
      : `${baseSql} ORDER BY r.sample_time DESC, r.id DESC LIMIT ${rowLimit}`;
    const result = await query(sql, params);
    res.json({ success: true, code: 0, data: result.rows });
  } catch (error) {
    console.error('Error fetching shared environmental-monitoring data:', error);
    res.status(500).json({ success: false, code: 500, error: 'Failed to fetch environmental-monitoring data' });
  }
});

// Send control command to a gateway
router.post('/control', requirePermission('send_command'), async (req: Request, res: Response) => {
  try {
    const { sncode, command } = req.body;
    if (!sncode || !command) {
      return res.status(400).json({ success: false, code: 400, error: 'Missing sncode or command in request body' });
    }

    const tokenInfo = (req as any).apiToken;
    const projectIds: number[] = tokenInfo.project_ids || [];

    // 1. Check if the gateway exists and get its publish_topic and project_id
    const gwResult = await query('SELECT project_id, publish_topic, status FROM gateway_info WHERE sncode = $1', [sncode]);
    if (gwResult.rows.length === 0) {
      return res.status(404).json({ success: false, code: 404, error: 'Gateway not found' });
    }

    const gateway = gwResult.rows[0];

    // 2. Check if the token has permission to access this gateway's project
    if (projectIds.length > 0) {
      // Find if gateway.project_id is in the allowed project tree
      const allowedResult = await query(`
        WITH RECURSIVE project_tree AS (
          SELECT id FROM projects WHERE id = ANY($1::int[])
          UNION
          SELECT p.id FROM projects p
          INNER JOIN project_tree pt ON p.parent_id = pt.id
        )
        SELECT 1 FROM project_tree WHERE id = $2
      `, [projectIds, gateway.project_id]);

      if (allowedResult.rows.length === 0) {
        return res.status(403).json({ success: false, code: 403, error: 'Permission denied for this gateway' });
      }
    }

    // 3. Check if publish_topic is configured
    if (!gateway.publish_topic) {
      return res.status(400).json({ success: false, code: 400, error: 'Gateway has no publish_topic configured' });
    }

    // 4. Publish via MQTT
    const mqttClient = getMqttClient();
    if (!mqttClient || !mqttClient.connected) {
      return res.status(500).json({ success: false, code: 500, error: 'MQTT client is not connected' });
    }

    const payload = typeof command === 'string' ? command : JSON.stringify(command);
    
    mqttClient.publish(gateway.publish_topic, payload, { qos: 1 }, (err) => {
      if (err) {
        console.error('Failed to publish MQTT message:', err);
        return res.status(500).json({ success: false, code: 500, error: 'Failed to send command to gateway' });
      }
      res.json({ success: true, code: 0, message: 'Command sent successfully', data: { topic: gateway.publish_topic } });
    });
  } catch (error) {
    console.error('Error in /control API:', error);
    res.status(500).json({ success: false, code: 500, error: 'Internal server error' });
  }
});

export default router;
