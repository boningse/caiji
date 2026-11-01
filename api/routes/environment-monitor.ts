import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import {
  decryptEnvironmentSecret,
  encryptEnvironmentSecret,
  ensureEnvironmentMonitorSchema,
  syncEnvironmentMonitorClients
} from '../environment-monitor.js';
import { verifyUserToken } from './auth.js';

const router = Router();
router.use(verifyUserToken);

const isAdmin = (req: Request) => (req as any).user?.role === 'ADMIN';
const adminOnly = (req: Request, res: Response) => {
  if (isAdmin(req)) return true;
  res.status(403).json({ success: false, error: '仅管理员可以管理环境监测接口配置' });
  return false;
};

const text = (value: unknown, maxLength: number) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, maxLength) : '';

const validateApiBaseUrl = (value: unknown) => {
  const candidate = text(value, 500) || 'http://www.0531yun.com';
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new Error('云平台 API 地址格式不正确'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('云平台 API 地址必须使用 HTTP 或 HTTPS');
  }
  return parsed.toString().replace(/\/$/, '');
};

const validateMqttBroker = (value: unknown) => {
  const input = text(value, 500) || 'mqtt://rtd.mqtt.0531yun.com:1883';
  const candidate = input.startsWith('tcp://') ? `mqtt://${input.slice('tcp://'.length)}` : input;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new Error('MQTT 地址格式不正确'); }
  if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('MQTT 地址协议必须为 mqtt、mqtts、ws 或 wss（协议 tcp:// 可直接填写）');
  }
  return parsed.toString().replace(/\/$/, '');
};

const apiEndpoint = (baseUrl: string, path: string) => new URL(path.replace(/^\//, ''), `${baseUrl.replace(/\/$/, '')}/`);

const parseApiResult = async (response: globalThis.Response) => {
  if (!response.ok) throw new Error('云平台接口暂不可用');
  const result = await response.json() as any;
  if (Number(result?.code) !== 1000) throw new Error('云平台认证或接口调用失败');
  return result;
};

const getPlatformToken = async (baseUrl: string, loginName: string, password: string) => {
  const endpoint = apiEndpoint(baseUrl, '/api/getToken');
  endpoint.searchParams.set('loginName', loginName);
  endpoint.searchParams.set('password', password);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
  const result = await parseApiResult(response);
  const token = text(result?.data?.token, 4096);
  if (!token) throw new Error('云平台未返回有效令牌');
  return token;
};

const fetchPlatformGroups = async (baseUrl: string, loginName: string, password: string) => {
  const token = await getPlatformToken(baseUrl, loginName, password);
  const endpoint = apiEndpoint(baseUrl, '/api/device/getGroupList');
  const response = await fetch(endpoint, {
    headers: { authorization: token },
    signal: AbortSignal.timeout(15_000)
  });
  const result = await parseApiResult(response);
  if (!Array.isArray(result?.data)) throw new Error('云平台分组列表格式不正确');
  return result.data.map((group: any) => ({
    groupId: text(group?.groupId, 128),
    groupName: text(group?.groupName, 255),
    parentId: text(group?.parentId, 128)
  })).filter((group: any) => group.groupId);
};

const getAllowedProjectIds = async (req: Request): Promise<number[] | null> => {
  const user = (req as any).user;
  if (user?.role === 'ADMIN') return null;
  const ids = (Array.isArray(user?.project_ids) ? user.project_ids : []).map(Number).filter(Number.isInteger);
  if (ids.length === 0) return [];
  const result = await query(`
    WITH RECURSIVE permitted_projects AS (
      SELECT id FROM projects WHERE id = ANY($1::int[])
      UNION
      SELECT p.id FROM projects p INNER JOIN permitted_projects pp ON p.parent_id = pp.id
    )
    SELECT id FROM permitted_projects
  `, [ids]);
  return result.rows.map((row: any) => Number(row.id));
};

const validDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

router.post('/remote/groups', async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    const baseUrl = validateApiBaseUrl(req.body?.apiBaseUrl);
    const loginName = text(req.body?.loginName, 128);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!loginName || !password) return res.status(400).json({ success: false, error: '请填写云平台登录名和密码' });
    const groups = await fetchPlatformGroups(baseUrl, loginName, password);
    res.json({ success: true, data: groups });
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法获取云平台分组';
    res.status(400).json({ success: false, error: message });
  }
});

router.get('/configs', async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    await ensureEnvironmentMonitorSchema();
    const result = await query(`
      SELECT c.id, c.project_id, p.code AS project_code, p.name AS project_name,
        c.name, c.api_base_url, c.mqtt_broker, c.login_name, c.group_id, c.group_name,
        c.enabled, c.connection_status, c.last_error, c.last_received_at,
        c.created_at, c.updated_at
      FROM environment_monitor_configs c
      JOIN projects p ON p.id = c.project_id
      ORDER BY c.created_at DESC, c.id DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Failed to load environment monitor configurations:', error);
    res.status(500).json({ success: false, error: '读取环境监测配置失败' });
  }
});

router.post('/configs', async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    await ensureEnvironmentMonitorSchema();
    const projectId = Number(req.body?.projectId);
    const name = text(req.body?.name, 128);
    const apiBaseUrl = validateApiBaseUrl(req.body?.apiBaseUrl);
    const mqttBroker = validateMqttBroker(req.body?.mqttBroker);
    const loginName = text(req.body?.loginName, 128);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const groupId = text(req.body?.groupId, 128);
    const groupName = text(req.body?.groupName, 255);
    const enabled = req.body?.enabled !== false;
    if (!Number.isInteger(projectId) || projectId <= 0 || !name || !loginName || !password || !groupId) {
      return res.status(400).json({ success: false, error: '项目、配置名称、平台账号、密码和分组均为必填项' });
    }
    const groups = await fetchPlatformGroups(apiBaseUrl, loginName, password);
    const matchedGroup = groups.find((group: any) => group.groupId === groupId);
    if (!matchedGroup) return res.status(400).json({ success: false, error: '所选分组不在当前云平台账号的分组列表中' });
    const encryptedPassword = encryptEnvironmentSecret(password);
    const result = await query(`
      INSERT INTO environment_monitor_configs
        (project_id, name, api_base_url, mqtt_broker, login_name, password_ciphertext, group_id, group_name, enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id
    `, [projectId, name, apiBaseUrl, mqttBroker, loginName, encryptedPassword, groupId, groupName || matchedGroup.groupName, enabled]);
    await syncEnvironmentMonitorClients();
    res.status(201).json({ success: true, data: { id: result.rows[0].id } });
  } catch (error) {
    const dbError = error as { code?: string };
    if (dbError.code === '23505') return res.status(409).json({ success: false, error: '该项目已经配置了这个云平台分组' });
    const message = error instanceof Error && (error.message.includes('地址') || error.message.includes('密钥'))
      ? error.message : '保存配置失败，请检查云平台账号、分组和服务器加密密钥';
    if (message === '保存配置失败，请检查云平台账号、分组和服务器加密密钥') {
      console.error('Failed to save environment monitor configuration');
    }
    res.status(400).json({ success: false, error: message });
  }
});

router.get('/configs/:id/groups', async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    await ensureEnvironmentMonitorSchema();
    const result = await query('SELECT api_base_url, login_name, password_ciphertext FROM environment_monitor_configs WHERE id = $1', [Number(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: '接口配置不存在' });
    const config = result.rows[0];
    const groups = await fetchPlatformGroups(config.api_base_url, config.login_name, decryptEnvironmentSecret(config.password_ciphertext));
    res.json({ success: true, data: groups });
  } catch {
    res.status(400).json({ success: false, error: '读取云平台分组失败，请检查账号和网络' });
  }
});

router.put('/configs/:id', async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    await ensureEnvironmentMonitorSchema();
    const id = Number(req.params.id);
    const currentResult = await query('SELECT * FROM environment_monitor_configs WHERE id = $1', [id]);
    if (!Number.isInteger(id) || currentResult.rows.length === 0) return res.status(404).json({ success: false, error: '接口配置不存在' });
    const current = currentResult.rows[0];
    const projectId = Number(req.body?.projectId);
    const name = text(req.body?.name, 128);
    const apiBaseUrl = validateApiBaseUrl(req.body?.apiBaseUrl);
    const mqttBroker = validateMqttBroker(req.body?.mqttBroker || current.mqtt_broker);
    const loginName = text(req.body?.loginName, 128);
    const newPassword = typeof req.body?.password === 'string' ? req.body.password : '';
    const password = newPassword || decryptEnvironmentSecret(current.password_ciphertext);
    const groupId = text(req.body?.groupId, 128);
    const groupName = text(req.body?.groupName, 255);
    const enabled = req.body?.enabled !== false;
    if (!Number.isInteger(projectId) || projectId <= 0 || !name || !loginName || !groupId) {
      return res.status(400).json({ success: false, error: '项目、配置名称、平台账号和分组均为必填项' });
    }
    const credentialsOrGroupChanged = Boolean(newPassword) || apiBaseUrl !== current.api_base_url ||
      loginName !== current.login_name || groupId !== current.group_id;
    const groups = credentialsOrGroupChanged ? await fetchPlatformGroups(apiBaseUrl, loginName, password) : [];
    const matchedGroup = groups.find((group: any) => group.groupId === groupId);
    if (credentialsOrGroupChanged && !matchedGroup) {
      return res.status(400).json({ success: false, error: '所选分组不在当前云平台账号的分组列表中' });
    }
    await query(`
      UPDATE environment_monitor_configs
      SET project_id=$1, name=$2, api_base_url=$3, mqtt_broker=$4, login_name=$5,
        password_ciphertext=$6, group_id=$7, group_name=$8, enabled=$9,
        connection_status='DISCONNECTED', last_error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE id=$10
    `, [projectId, name, apiBaseUrl, mqttBroker, loginName,
      newPassword ? encryptEnvironmentSecret(newPassword) : current.password_ciphertext,
      groupId, groupName || matchedGroup?.groupName || current.group_name, enabled, id]);
    await syncEnvironmentMonitorClients();
    res.json({ success: true });
  } catch (error) {
    const dbError = error as { code?: string };
    if (dbError.code === '23505') return res.status(409).json({ success: false, error: '该项目已经配置了这个云平台分组' });
    const message = error instanceof Error && error.message.includes('地址') ? error.message : '更新配置失败，请检查云平台账号、分组和服务器加密密钥';
    console.error('Failed to update environment monitor configuration');
    res.status(400).json({ success: false, error: message });
  }
});

router.delete('/configs/:id', async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    await ensureEnvironmentMonitorSchema();
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: '配置编号无效' });
    await query('DELETE FROM environment_monitor_configs WHERE id = $1', [id]);
    await syncEnvironmentMonitorClients();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete environment monitor configuration:', error);
    res.status(500).json({ success: false, error: '删除配置失败' });
  }
});

router.get('/readings', async (req, res) => {
  try {
    await ensureEnvironmentMonitorSchema();
    const start = req.query.start ? validDate(req.query.start) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = req.query.end ? validDate(req.query.end) : new Date();
    if (!start || !end || start > end) return res.status(400).json({ success: false, error: '查询时间无效' });
    const page = Math.min(Math.max(Number.parseInt(String(req.query.page || '1'), 10) || 1, 1), 100000);
    const pageSize = Math.min(Math.max(Number.parseInt(String(req.query.pageSize || '20'), 10) || 20, 1), 100);
    const search = text(req.query.search, 128);
    const allowedProjects = await getAllowedProjectIds(req);
    const selectedProjectId = req.query.projectId ? Number(req.query.projectId) : null;
    if (selectedProjectId && (!Number.isInteger(selectedProjectId) || (allowedProjects && !allowedProjects.includes(selectedProjectId)))) {
      return res.status(403).json({ success: false, error: '无权查看该项目的环境监测数据' });
    }

    const params: any[] = [start.toISOString(), end.toISOString()];
    const conditions = ['r.sample_time >= $1', 'r.sample_time <= $2'];
    if (allowedProjects) {
      params.push(allowedProjects);
      conditions.push(`r.project_id = ANY($${params.length}::int[])`);
    }
    if (selectedProjectId) {
      params.push(selectedProjectId);
      conditions.push(`r.project_id = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(r.device_name ILIKE $${params.length} OR r.device_addr::text ILIKE $${params.length} OR r.factor_name ILIKE $${params.length} OR r.function_name ILIKE $${params.length} OR r.function_code ILIKE $${params.length} OR r.factor_id ILIKE $${params.length} OR p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`);
    }
    const functionCode = text(req.query.functionCode, 64);
    if (functionCode) {
      params.push(functionCode);
      conditions.push(`r.function_code = $${params.length}`);
    }
    const whereSql = conditions.join(' AND ');
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM environment_monitor_readings r JOIN projects p ON p.id=r.project_id WHERE ${whereSql}`, params);
    const summaryResult = await query(`
      SELECT COUNT(*) FILTER (WHERE r.sample_time >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai'))::int AS today_count,
        COUNT(DISTINCT (r.project_id, r.device_addr))::int AS device_count,
        MAX(r.received_at) AS latest_received_at
      FROM environment_monitor_readings r
      JOIN projects p ON p.id=r.project_id
      WHERE ${whereSql}
    `, params);
    const listParams = [...params, pageSize, (page - 1) * pageSize];
    const listResult = await query(`
      SELECT r.id, r.project_id, p.code AS project_code, p.name AS project_name,
        r.group_id, r.device_addr, r.device_name, r.device_status, r.node_id, r.register_id,
        r.factor_id, r.factor_name, r.device_function_id, r.function_code, r.function_name,
        r.data_type, r.data_text, r.value, r.unit, r.alarm_level,
        r.alarm_color, r.alarm_info, r.sample_time, r.received_at
      FROM environment_monitor_readings r
      JOIN projects p ON p.id=r.project_id
      WHERE ${whereSql}
      ORDER BY r.sample_time DESC, r.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, listParams);
    res.json({
      success: true,
      data: listResult.rows,
      summary: { total: Number(countResult.rows[0]?.total || 0), ...(summaryResult.rows[0] || {}) },
      page,
      pageSize
    });
  } catch (error) {
    console.error('Failed to load environment monitor readings:', error);
    res.status(500).json({ success: false, error: '读取环境监测数据失败' });
  }
});

export default router;
