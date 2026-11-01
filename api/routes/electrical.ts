import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { distributeData } from '../distributor.js';
import { verifyUserToken } from './auth.js';

const router = Router();

let schemaReady: Promise<void> | null = null;
const ensureElectricalSchema = () => {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS electrical_readings (
          id BIGSERIAL,
          batch_id UUID NOT NULL,
          device_code VARCHAR(128) NOT NULL,
          project_id INT REFERENCES projects(id) ON DELETE SET NULL,
          point_id INT,
          insname VARCHAR(128) NOT NULL,
          propertyno VARCHAR(64) NOT NULL,
          paraname VARCHAR(64) NOT NULL,
          quality INT NOT NULL,
          value NUMERIC(24, 6) NOT NULL,
          report_time TIMESTAMPTZ NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id, report_time),
          UNIQUE (point_id, propertyno, paraname, report_time)
        )
      `);
      await query(`SELECT create_hypertable(
        'electrical_readings', 'report_time',
        if_not_exists => TRUE,
        migrate_data => TRUE,
        chunk_time_interval => INTERVAL '7 days'
      )`);
      await query('CREATE INDEX IF NOT EXISTS idx_electrical_readings_received_at ON electrical_readings(received_at DESC)');
      await query('CREATE INDEX IF NOT EXISTS idx_electrical_readings_project_time ON electrical_readings(project_id, report_time DESC)');
      await query('CREATE INDEX IF NOT EXISTS idx_electrical_readings_device_time ON electrical_readings(device_code, report_time DESC)');
      await query(`ALTER TABLE electrical_readings SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'project_id',
        timescaledb.compress_orderby = 'report_time DESC, point_id, propertyno, paraname, id'
      )`);
      await query(`SELECT add_compression_policy('electrical_readings', INTERVAL '30 days', if_not_exists => TRUE)`);
      await query('ALTER TABLE telemetry_data ADD COLUMN IF NOT EXISTS project_id INT');
      await query('ALTER TABLE telemetry_data ADD COLUMN IF NOT EXISTS point_id INT');
      await query('CREATE INDEX IF NOT EXISTS idx_telemetry_data_project_id ON telemetry_data(project_id, ts DESC)');
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
};

const apiError = (res: Response, status: number, code: number, msg: string, detail?: unknown) =>
  res.status(status).json({ success: false, code, msg, ...(detail === undefined ? {} : { detail }) });

const textValue = (value: unknown, maxLength: number) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, maxLength) : '';

const finiteNumber = (value: unknown): number | null => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseReportTime = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const utc = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const shifted = new Date(utc + 8 * 60 * 60 * 1000);
  if (
    shifted.getUTCFullYear() !== year || shifted.getUTCMonth() !== month - 1 ||
    shifted.getUTCDate() !== day || shifted.getUTCHours() !== hour ||
    shifted.getUTCMinutes() !== minute || shifted.getUTCSeconds() !== second
  ) return null;
  return new Date(utc);
};

interface MappedReading {
  deviceCode: string;
  projectId: number;
  pointId: number;
  pointName: string;
  insname: string;
  propertyno: string;
  paraname: string;
  quality: number;
  value: number;
}

router.post('/upload-data', async (req: Request, res: Response) => {
  try {
    await ensureElectricalSchema();
    const reportTime = parseReportTime(req.body?.reportTime);
    const projectCode = textValue(req.body?.projectCode, 64);
    const commonDeviceCode = textValue(req.body?.deviceCode ?? req.body?.deviceNo, 128);
    const items = Array.isArray(req.body?.data) ? req.body.data : Array.isArray(req.body?.points) ? req.body.points : null;

    if (!reportTime) return apiError(res, 400, 400, 'reportTime 格式必须为 yyyy-MM-dd HH:mm:ss');
    if (!items || items.length === 0) return apiError(res, 400, 400, 'data 必须是非空数组');
    if (items.length > 200) return apiError(res, 400, 400, '单次最多上报 200 个电气数据点');

    const mapped: MappedReading[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] || {};
      const deviceCode = textValue(item.deviceCode ?? item.deviceNo, 128) || commonDeviceCode;
      const insname = textValue(item.insname ?? item.pointCode, 128);
      const propertyno = textValue(item.propertyno ?? item.propertyNo, 64);
      const paraname = textValue(item.paraname ?? item.parameterName, 64) || '电气数据';
      const value = finiteNumber(item.value);
      const qualityValue = item.quality === undefined ? 1 : Number(item.quality);

      if (!deviceCode && !insname) return apiError(res, 400, 400, `data[${index}] 至少需要 deviceCode 或 insname`);
      if (value === null) return apiError(res, 400, 400, `data[${index}].value 必须是有效数字`);
      if (!Number.isInteger(qualityValue) || qualityValue < 0 || qualityValue > 255) {
        return apiError(res, 400, 400, `data[${index}].quality 必须是 0-255 的整数`);
      }

      const params: any[] = [];
      const conditions = ["pp.status = 'ACTIVE'"];
      if (deviceCode) { params.push(deviceCode); conditions.push(`BTRIM(COALESCE(pp.device_code, '')) = $${params.length}`); }
      if (insname) { params.push(insname); conditions.push(`BTRIM(COALESCE(pp.insname, '')) = $${params.length}`); }
      if (propertyno) { params.push(propertyno); conditions.push(`BTRIM(COALESCE(pp.propertyno, '')) = $${params.length}`); }
      if (projectCode) { params.push(projectCode); conditions.push(`BTRIM(COALESCE(pr.code, '')) = $${params.length}`); }

      const pointResult = await query(`
        SELECT pp.id, pp.project_id, pp.name, pp.device_code, pp.insname, pp.propertyno
        FROM project_points pp
        LEFT JOIN projects pr ON pr.id = pp.project_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY pp.id
      `, params);

      if (pointResult.rows.length === 0) {
        return apiError(res, 404, 404, `data[${index}] 未匹配到点位，请检查设备地址、点位标识和属性号`);
      }
      if (pointResult.rows.length > 1) {
        return apiError(res, 409, 409, `data[${index}] 匹配到多个点位，请增加 projectCode 或 insname 进行区分`);
      }

      const point = pointResult.rows[0];
      mapped.push({
        deviceCode: deviceCode || String(point.device_code || ''),
        projectId: Number(point.project_id),
        pointId: Number(point.id),
        pointName: point.name,
        insname: String(point.insname || insname),
        propertyno: propertyno || String(point.propertyno || ''),
        paraname,
        quality: qualityValue,
        value
      });
    }

    const batchId = randomUUID();
    const accepted: MappedReading[] = [];
    for (const item of mapped) {
      const inserted = await query(`
        INSERT INTO electrical_readings
          (batch_id, device_code, project_id, point_id, insname, propertyno, paraname, quality, value, report_time)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (point_id, propertyno, paraname, report_time) DO NOTHING
        RETURNING id
      `, [batchId, item.deviceCode, item.projectId, item.pointId, item.insname, item.propertyno, item.paraname, item.quality, item.value, reportTime]);
      if (inserted.rows.length > 0) accepted.push(item);
    }

    if (accepted.length > 0) {
      try {
        const values: any[] = [];
        const rows = accepted.map((item, index) => {
          const offset = index * 11;
          values.push('', item.deviceCode, item.pointName, item.insname, item.propertyno, item.paraname,
            item.quality, String(item.value), reportTime, item.projectId, item.pointId);
          return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11})`;
        });
        await query(`
          INSERT INTO telemetry_data
            (gateway_sncode, device_code, point_name, insname, propertyno, paraname, quality, value, ts, project_id, point_id)
          VALUES ${rows.join(',')}
        `, values);
      } catch (error) {
        await query('DELETE FROM electrical_readings WHERE batch_id = $1 AND report_time = $2', [batchId, reportTime]);
        throw error;
      }

      const byProject = new Map<number, MappedReading[]>();
      for (const item of accepted) byProject.set(item.projectId, [...(byProject.get(item.projectId) || []), item]);
      for (const [projectId, projectItems] of byProject) {
        distributeData('', projectItems, reportTime, projectId)
          .catch((error) => console.error('Electrical data distribution failed:', error));
      }
    }

    return res.json({
      success: true,
      code: 0,
      msg: '成功',
      data: {
        batchId,
        total: mapped.length,
        accepted: accepted.length,
        duplicate: mapped.length - accepted.length,
        points: mapped.map((item) => ({ pointId: item.pointId, pointName: item.pointName, projectId: item.projectId }))
      }
    });
  } catch (error) {
    console.error('Receive electrical data failed:', error);
    return apiError(res, 500, 500, '电气数据接收失败');
  }
});

router.get('/readings', verifyUserToken, async (req: Request, res: Response) => {
  try {
    await ensureElectricalSchema();
    const user = (req as any).user || {};
    const projectIds: number[] = (user.project_ids || []).map(Number);
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || '20'), 10) || 20, 1), 200);
    const search = String(req.query.search || '').trim();
    const start = req.query.start ? new Date(String(req.query.start)) : null;
    const end = req.query.end ? new Date(String(req.query.end)) : null;
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime())) || (start && end && start > end)) {
      return apiError(res, 400, 400, '查询时间范围无效');
    }

    const params: any[] = [];
    let cte = '';
    const conditions: string[] = [];
    if (projectIds.length > 0) {
      params.push(projectIds);
      cte = `WITH RECURSIVE project_tree AS (
        SELECT id FROM projects WHERE id = ANY($1::int[])
        UNION SELECT p.id FROM projects p JOIN project_tree pt ON p.parent_id = pt.id
      )`;
      conditions.push('er.project_id IN (SELECT id FROM project_tree)');
    }
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      conditions.push(`(er.device_code ILIKE ${p} OR er.insname ILIKE ${p} OR er.paraname ILIKE ${p} OR COALESCE(pp.name, '') ILIKE ${p} OR COALESCE(pr.name, '') ILIKE ${p} OR COALESCE(pr.code, '') ILIKE ${p})`);
    }
    if (start) { params.push(start); conditions.push(`er.report_time >= $${params.length}`); }
    if (end) { params.push(end); conditions.push(`er.report_time <= $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const from = `FROM electrical_readings er
      LEFT JOIN project_points pp ON pp.id = er.point_id
      LEFT JOIN projects pr ON pr.id = er.project_id`;

    const summaryResult = await query(`${cte}
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE er.received_at >= date_trunc('day', CURRENT_TIMESTAMP))::int AS today,
        COUNT(DISTINCT er.point_id)::int AS point_count,
        MAX(er.received_at) AS latest_received_at
      ${from} ${where}`, params);

    const listParams = [...params, pageSize, (page - 1) * pageSize];
    const listResult = await query(`${cte}
      SELECT er.id, er.batch_id, er.device_code, er.insname, er.propertyno, er.paraname,
        er.quality, er.value, er.report_time, er.received_at, pp.name AS point_name,
        pr.id AS project_id, pr.code AS project_code, pr.name AS project_name
      ${from} ${where}
      ORDER BY er.received_at DESC, er.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, listParams);

    const summary = summaryResult.rows[0];
    return res.json({ success: true, code: 0, data: listResult.rows, total: summary.total, summary });
  } catch (error) {
    console.error('Fetch electrical readings failed:', error);
    return apiError(res, 500, 500, '查询电气数据失败');
  }
});

export default router;
