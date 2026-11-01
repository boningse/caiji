import express, { Request, Response } from 'express';
import { getClient, query } from '../db.js';
import { verifyUserToken } from './auth.js';
import { getMqttClient } from '../mqtt.js';
import {
  replaceGatewayProjectBindings,
  validateGatewayProjectSelection,
} from '../gateway-projects.js';

const router = express.Router();

router.use(verifyUserToken);

// Helper to get allowed project IDs including children
const getAllowedProjectIds = async (userProjectIds: number[]): Promise<number[]> => {
  if (userProjectIds.length === 0) return [];
  const allProjects = await query('SELECT id, parent_id FROM projects');
  const allowed = new Set<number>(userProjectIds);
  
  let added = true;
  while (added) {
    added = false;
    for (const p of allProjects.rows) {
      if (p.parent_id && allowed.has(p.parent_id) && !allowed.has(p.id)) {
        allowed.add(p.id);
        added = true;
      }
    }
  }
  return Array.from(allowed);
};

// Get all gateways
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    let sql = `
      SELECT g.*, p.name as project_name,
             COALESCE(
               bindings.project_ids,
               CASE WHEN g.project_id IS NULL THEN '{}'::int[] ELSE ARRAY[g.project_id]::int[] END
             ) AS project_ids,
             COALESCE(bindings.associated_project_ids, '{}'::int[]) AS associated_project_ids,
             COALESCE(bindings.associated_projects, '[]'::json) AS associated_projects
      FROM gateway_info g
      LEFT JOIN projects p ON g.project_id = p.id
      LEFT JOIN LATERAL (
        SELECT array_agg(gpb.project_id ORDER BY CASE gpb.binding_type WHEN 'PRIMARY' THEN 0 ELSE 1 END, gpb.project_id) AS project_ids,
               array_agg(gpb.project_id ORDER BY gpb.project_id) FILTER (WHERE gpb.binding_type = 'SHARED') AS associated_project_ids,
               json_agg(json_build_object('id', child.id, 'name', child.name, 'level', child.level) ORDER BY child.level, child.name)
                 FILTER (WHERE gpb.binding_type = 'SHARED') AS associated_projects
        FROM gateway_project_bindings gpb
        JOIN projects child ON child.id = gpb.project_id
        WHERE gpb.gateway_sncode = g.sncode
      ) bindings ON TRUE
    `;
    const params: any[] = [];

    if (user.role !== 'ADMIN') {
      const allowedIds = await getAllowedProjectIds(user.project_ids || []);
      if (allowedIds.length === 0) {
        return res.json({ success: true, data: [] });
      }
      sql += ` WHERE g.project_id = ANY($1::int[])
        OR EXISTS (
          SELECT 1 FROM gateway_project_bindings permitted
          WHERE permitted.gateway_sncode = g.sncode
            AND permitted.project_id = ANY($1::int[])
        )`;
      params.push(allowedIds);
    }

    sql += ` ORDER BY g.created_at DESC`;
    
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch gateways' });
  }
});

// Get overview (Dashboard data)
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    
    // Default filters for ADMIN
    let projectFilter = '';
    let params: any[] = [];
    
    if (user.role !== 'ADMIN') {
      const allowedIds = await getAllowedProjectIds(user.project_ids || []);
      if (allowedIds.length === 0) {
        return res.json({
          success: true,
          data: {
            totalGateways: 0,
            onlineGateways: 0,
            totalProjects: 0,
            apiTokens: 0,
            systemUptime: process.uptime(),
            mqttStatus: getMqttClient()?.connected ? '已连接' : '未连接'
          }
        });
      }
      projectFilter = `WHERE (project_id = ANY($1::int[])
        OR EXISTS (
          SELECT 1 FROM gateway_project_bindings permitted
          WHERE permitted.gateway_sncode = gateway_info.sncode
            AND permitted.project_id = ANY($1::int[])
        ))`;
      params.push(allowedIds);
    }

    const gatewayCount = await query(`SELECT COUNT(*) as count FROM gateway_info ${projectFilter}`, params);
    
    const onlineFilter = projectFilter ? `${projectFilter} AND status = 'ONLINE'` : `WHERE status = 'ONLINE'`;
    const onlineCount = await query(`SELECT COUNT(*) as count FROM gateway_info ${onlineFilter}`, params);
    
    // Project count
    let projectCountResult;
    if (user.role === 'ADMIN') {
      projectCountResult = await query('SELECT COUNT(*) as count FROM projects');
    } else {
      projectCountResult = { rows: [{ count: (await getAllowedProjectIds(user.project_ids || [])).length }] };
    }

    // API tokens (Only admin really cares, but we can show it)
    const tokenCount = await query("SELECT COUNT(*) as count FROM api_tokens WHERE status = 'ACTIVE'");

    // Try to get total data points collected today from the current month's table
    const currentDate = new Date();
    
    let todayDataCount = 0;
    try {
      const todayStr = currentDate.toISOString().split('T')[0];
      // If not admin, we would ideally filter by gateway_sncode, but for performance we might just show global or 0
      // For simplicity and performance, we show global data count for admin, and 0 for users for now
      if (user.role === 'ADMIN') {
        const countRes = await query(`SELECT COUNT(*) as count FROM telemetry_data WHERE DATE(ts) = $1`, [todayStr]);
        todayDataCount = parseInt(countRes.rows[0].count);
      }
    } catch (e) {
      console.error('Error counting today data:', e);
    }

    res.json({
      success: true,
      data: {
        totalGateways: parseInt(gatewayCount.rows[0].count),
        onlineGateways: parseInt(onlineCount.rows[0].count),
        totalProjects: parseInt(projectCountResult.rows[0].count),
        activeApiTokens: parseInt(tokenCount.rows[0].count),
        todayDataCount,
        systemUptime: process.uptime(),
        mqttStatus: getMqttClient()?.connected ? '已连接' : '已断开'
      }
    });
  } catch (error) {
    console.error('Error fetching overview:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch overview' });
  }
});

// Get recent telemetry data
router.get('/telemetry', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { startDate, endDate, page = '1', pageSize = '50', search, secondarySearch } = req.query;
    let allowedIds: number[] = [];
    
    if (user.role !== 'ADMIN') {
      allowedIds = await getAllowedProjectIds(user.project_ids || []);
      if (allowedIds.length === 0) {
        return res.json({ success: true, data: [], total: 0 });
      }
    }

    let baseSql = `
      FROM telemetry_data t
      LEFT JOIN gateway_info g ON t.gateway_sncode = g.sncode
      LEFT JOIN projects p ON COALESCE(t.project_id, g.project_id) = p.id
      WHERE 1=1
    `;
    
    const params: any[] = [];
    let paramIndex = 1;
    
    if (user.role !== 'ADMIN') {
      baseSql += ` AND COALESCE(t.project_id, g.project_id) = ANY($${paramIndex}::int[])`;
      params.push(allowedIds);
      paramIndex++;
    }

    if (startDate) {
      baseSql += ` AND t.ts >= $${paramIndex}`;
      params.push(new Date(startDate as string));
      paramIndex++;
    }

    if (endDate) {
      baseSql += ` AND t.ts <= $${paramIndex}`;
      params.push(new Date(endDate as string));
      paramIndex++;
    }

    if (search) {
      baseSql += ` AND (t.gateway_sncode ILIKE $${paramIndex} OR t.device_code ILIKE $${paramIndex} OR p.code ILIKE $${paramIndex} OR p.name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (secondarySearch) {
      baseSql += ` AND (t.insname ILIKE $${paramIndex} OR t.point_name ILIKE $${paramIndex} OR t.propertyno ILIKE $${paramIndex})`;
      params.push(`%${secondarySearch}%`);
      paramIndex++;
    }
    
    const countSql = `SELECT count(*) as total ${baseSql}`;
    const countResult = await query(countSql, params);
    const total = parseInt(countResult.rows[0].total, 10);

    const limit = parseInt(pageSize as string, 10);
    const offset = (parseInt(page as string, 10) - 1) * limit;

    let dataSql = `
      SELECT t.*, p.code as project_code, p.name as project_name 
      ${baseSql}
      ORDER BY t.ts DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(limit, offset);

    const result = await query(dataSql, params);
    res.json({ success: true, data: result.rows, total });
  } catch (error) {
    console.error('Error fetching recent telemetry data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch telemetry data' });
  }
});

// Get raw MQTT logs
router.get('/raw-logs', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { startDate, endDate, page = '1', pageSize = '50', search } = req.query;
    let allowedIds: number[] = [];
    
    if (user.role !== 'ADMIN') {
      allowedIds = await getAllowedProjectIds(user.project_ids || []);
      if (allowedIds.length === 0) {
        return res.json({ success: true, data: [], total: 0 });
      }
    }

    let baseSql = `
      FROM raw_mqtt_logs r
    `;
    
    const params: any[] = [];
    let paramIndex = 1;

    let hasWhere = false;

    if (user.role !== 'ADMIN') {
      baseSql += `
        INNER JOIN gateway_info g ON r.gateway_sncode = g.sncode
        WHERE (g.project_id = ANY($${paramIndex}::int[])
          OR EXISTS (
            SELECT 1 FROM gateway_project_bindings permitted
            WHERE permitted.gateway_sncode = g.sncode
              AND permitted.project_id = ANY($${paramIndex}::int[])
          ))
      `;
      params.push(allowedIds);
      paramIndex++;
      hasWhere = true;
    }

    const appendCondition = (condition: string) => {
      if (!hasWhere) {
        baseSql += ` WHERE ${condition}`;
        hasWhere = true;
      } else {
        baseSql += ` AND ${condition}`;
      }
    };

    if (startDate) {
      appendCondition(`r.received_at >= $${paramIndex}`);
      params.push(new Date(startDate as string));
      paramIndex++;
    }

    if (endDate) {
      appendCondition(`r.received_at <= $${paramIndex}`);
      params.push(new Date(endDate as string));
      paramIndex++;
    }

    if (search) {
      appendCondition(`r.gateway_sncode ILIKE $${paramIndex}`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const countSql = `SELECT count(*) as total ${baseSql}`;
    const countResult = await query(countSql, params);
    const total = parseInt(countResult.rows[0].total, 10);

    const limit = parseInt(pageSize as string, 10);
    const offset = (parseInt(page as string, 10) - 1) * limit;

    let dataSql = `
      SELECT r.* 
      ${baseSql}
      ORDER BY r.received_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(limit, offset);

    const result = await query(dataSql, params);
    res.json({ success: true, data: result.rows, total });
  } catch (error) {
    console.error('Error fetching raw logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch raw logs' });
  }
});

// Get telemetry data for a specific gateway
router.get('/:sncode/telemetry', async (req: Request, res: Response) => {
  const { sncode } = req.params;
  const { startDate, endDate, page = '1', pageSize = '50' } = req.query;
  try {
    const user = (req as any).user;
    
    // Check permission
    if (user.role !== 'ADMIN') {
      const allowedIds = await getAllowedProjectIds(user.project_ids || []);
      const gwResult = await query(
        `SELECT 1
         FROM gateway_info g
         WHERE g.sncode = $1
           AND (g.project_id = ANY($2::int[]) OR EXISTS (
             SELECT 1 FROM gateway_project_bindings permitted
             WHERE permitted.gateway_sncode = g.sncode
               AND permitted.project_id = ANY($2::int[])
           ))`,
        [sncode, allowedIds],
      );
      if (gwResult.rows.length === 0) {
        return res.status(403).json({ success: false, error: 'Permission denied for this gateway' });
      }
    }

    let baseSql = `FROM telemetry_data WHERE gateway_sncode = $1`;
    const params: any[] = [sncode];
    let paramIndex = 2;

    if (user.role !== 'ADMIN') {
      const allowedIds = await getAllowedProjectIds(user.project_ids || []);
      baseSql += ` AND project_id = ANY($${paramIndex}::int[])`;
      params.push(allowedIds);
      paramIndex++;
    }
    
    if (startDate) {
      baseSql += ` AND ts >= $${paramIndex}`;
      params.push(new Date(startDate as string));
      paramIndex++;
    }
    
    if (endDate) {
      baseSql += ` AND ts <= $${paramIndex}`;
      params.push(new Date(endDate as string));
      paramIndex++;
    }
    
    const countSql = `SELECT count(*) as total ${baseSql}`;
    const countResult = await query(countSql, params);
    const total = parseInt(countResult.rows[0].total, 10);

    const limit = parseInt(pageSize as string, 10);
    const offset = (parseInt(page as string, 10) - 1) * limit;

    let dataSql = `
      SELECT * 
      ${baseSql}
      ORDER BY ts DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(limit, offset);
    
    const result = await query(dataSql, params);
    res.json({ success: true, data: result.rows, total });
  } catch (error) {
    console.error('Error fetching telemetry data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch telemetry data' });
  }
});

// Create a new gateway
router.post('/', async (req: Request, res: Response) => {
  const { sncode, alias, ip_address, project_id, associated_project_ids, publish_topic, subscribe_topic } = req.body;
  try {
    // Check if gateway already exists
    const existing = await query('SELECT sncode FROM gateway_info WHERE sncode = $1', [sncode]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Gateway SN code already exists' });
    }

    const { primaryProjectId, associatedProjectIds } = await validateGatewayProjectSelection(project_id, associated_project_ids);
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO gateway_info (sncode, alias, ip_address, project_id, publish_topic, subscribe_topic, status, last_offline_time) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)',
        [sncode, alias, ip_address || '', primaryProjectId, publish_topic || null, subscribe_topic || null, 'OFFLINE'],
      );
      await replaceGatewayProjectBindings(client, sncode, primaryProjectId, associatedProjectIds);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Dynamically subscribe to the new topic if it exists
    if (subscribe_topic) {
      const mqttClient = getMqttClient();
      if (mqttClient && mqttClient.connected) {
        const isPAck = /^p\/[^/]+ack$/.test(subscribe_topic);
        if (!isPAck) {
          mqttClient.subscribe(subscribe_topic, (err) => {
            if (!err) console.log(`Dynamically subscribed to new custom MQTT topic: ${subscribe_topic}`);
          });
        }
      }
    }

    res.json({ success: true, message: 'Gateway created' });
  } catch (error) {
    console.error('Error creating gateway:', error);
    const message = error instanceof Error ? error.message : 'Failed to create gateway';
    res.status(message.includes('项目') ? 400 : 500).json({ success: false, error: message });
  }
});

// Delete a gateway
router.delete('/:sncode', async (req: Request, res: Response) => {
  const { sncode } = req.params;
  try {
    await query('DELETE FROM gateway_info WHERE sncode = $1', [sncode]);
    res.json({ success: true, message: 'Gateway deleted' });
  } catch (error) {
    console.error('Error deleting gateway:', error);
    res.status(500).json({ success: false, error: 'Failed to delete gateway' });
  }
});

// Edit a gateway
router.put('/:sncode', async (req: Request, res: Response) => {
  const { sncode } = req.params;
  const { alias, ip_address, project_id, associated_project_ids, publish_topic, subscribe_topic } = req.body;
  try {
    const { primaryProjectId, associatedProjectIds } = await validateGatewayProjectSelection(project_id, associated_project_ids);

    // Get old subscribe_topic to unsubscribe if changed
    const oldGw = await query('SELECT subscribe_topic FROM gateway_info WHERE sncode = $1', [sncode]);
    const oldSubscribeTopic = oldGw.rows.length > 0 ? oldGw.rows[0].subscribe_topic : null;

    const client = await getClient();
    let result;
    try {
      await client.query('BEGIN');
      result = await client.query(
        'UPDATE gateway_info SET alias = $1, ip_address = $2, project_id = $3, publish_topic = $4, subscribe_topic = $5, updated_at = CURRENT_TIMESTAMP WHERE sncode = $6 RETURNING *',
        [alias, ip_address || '', primaryProjectId, publish_topic || null, subscribe_topic || null, sncode],
      );
      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Gateway not found' });
      }
      await replaceGatewayProjectBindings(client, sncode, primaryProjectId, associatedProjectIds);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const mqttClient = getMqttClient();
    if (mqttClient && mqttClient.connected) {
      // If topic changed or removed, unsubscribe from the old one
      if (oldSubscribeTopic && oldSubscribeTopic !== subscribe_topic) {
        mqttClient.unsubscribe(oldSubscribeTopic, (err) => {
          if (!err) console.log(`Unsubscribed from old custom MQTT topic: ${oldSubscribeTopic}`);
        });
      }
      // If new topic is provided and different, subscribe to it
      if (subscribe_topic && oldSubscribeTopic !== subscribe_topic) {
        const isPAck = /^p\/[^/]+ack$/.test(subscribe_topic);
        if (!isPAck) {
          mqttClient.subscribe(subscribe_topic, (err) => {
            if (!err) console.log(`Dynamically subscribed to updated custom MQTT topic: ${subscribe_topic}`);
          });
        }
      }
    }
    
    res.json({ success: true, message: 'Gateway updated', data: result.rows[0] });
  } catch (error) {
    console.error('Error updating gateway:', error);
    const message = error instanceof Error ? error.message : 'Failed to update gateway';
    res.status(message.includes('项目') ? 400 : 500).json({ success: false, error: message });
  }
});

// Internal Control API for dashboard (requires user token)
router.post('/control', async (req: Request, res: Response) => {
  try {
    const { sncode, command } = req.body;
    if (!sncode || !command) {
      return res.status(400).json({ success: false, error: 'Missing sncode or command in request body' });
    }

    const user = (req as any).user;
    
    // 1. Check if gateway exists and get info
    const gwResult = await query('SELECT project_id, publish_topic, status FROM gateway_info WHERE sncode = $1', [sncode]);
    if (gwResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Gateway not found' });
    }

    const gateway = gwResult.rows[0];

    // 2. Check user permission
    if (user.role !== 'ADMIN') {
      const allowedIds = await getAllowedProjectIds(user.project_ids || []);
      if (!gateway.project_id || !allowedIds.includes(gateway.project_id)) {
        return res.status(403).json({ success: false, error: 'Permission denied for this gateway' });
      }
    }

    // 3. Check publish topic
    if (!gateway.publish_topic) {
      return res.status(400).json({ success: false, error: 'Gateway has no publish_topic configured' });
    }

    // 4. Publish via MQTT
    const mqttClient = getMqttClient();
    if (!mqttClient || !mqttClient.connected) {
      return res.status(500).json({ success: false, error: 'MQTT client is not connected' });
    }

    const payload = typeof command === 'string' ? command : JSON.stringify(command);
    
    mqttClient.publish(gateway.publish_topic, payload, { qos: 1 }, (err) => {
      if (err) {
        console.error('Failed to publish MQTT message:', err);
        return res.status(500).json({ success: false, error: 'Failed to send command to gateway' });
      }
      res.json({ success: true, message: 'Command sent successfully', data: { topic: gateway.publish_topic } });
    });
  } catch (error) {
    console.error('Error in internal /control API:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
