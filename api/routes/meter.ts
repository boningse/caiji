import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { distributeData } from '../distributor.js';
import { verifyUserToken } from './auth.js';

const router = Router();

let schemaReady: Promise<void> | null = null;
const ensureMeterSchema = () => {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS meter_readings (
          id BIGSERIAL,
          request_id UUID NOT NULL,
          meter_no VARCHAR(64) NOT NULL,
          project_id INT REFERENCES projects(id) ON DELETE SET NULL,
          acc NUMERIC(18, 3) NOT NULL,
          valve VARCHAR(16) NOT NULL,
          mcu INT,
          voltage NUMERIC(10, 3),
          report_time TIMESTAMPTZ NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id, report_time),
          UNIQUE (request_id, report_time),
          UNIQUE (meter_no, report_time)
        )
      `);
      await query(`SELECT create_hypertable(
        'meter_readings', 'report_time',
        if_not_exists => TRUE,
        migrate_data => TRUE,
        chunk_time_interval => INTERVAL '7 days'
      )`);
      await query('CREATE INDEX IF NOT EXISTS idx_meter_readings_report_time ON meter_readings(report_time DESC)');
      await query('CREATE INDEX IF NOT EXISTS idx_meter_readings_received_at ON meter_readings(received_at DESC)');
      await query('CREATE INDEX IF NOT EXISTS idx_meter_readings_project_id ON meter_readings(project_id)');
      await query('ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS point_id INT');
      await query('CREATE INDEX IF NOT EXISTS idx_meter_readings_point_id ON meter_readings(point_id)');
      await query('CREATE INDEX IF NOT EXISTS idx_meter_readings_project_time ON meter_readings(project_id, report_time DESC)');
      await query(`ALTER TABLE meter_readings SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'project_id',
        timescaledb.compress_orderby = 'report_time DESC, meter_no, id, request_id'
      )`);
      await query(`SELECT add_compression_policy('meter_readings', INTERVAL '30 days', if_not_exists => TRUE)`);
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

const apiError = (res: Response, status: number, code: number, msg: string) =>
  res.status(status).json({ success: false, code, msg });

const parseReportTime = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
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

const finiteNumber = (value: unknown): number | null => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

router.post('/upload-data', async (req: Request, res: Response) => {
  try {
    await ensureMeterSchema();
    const meterNo = typeof req.body?.meterNo === 'string' ? req.body.meterNo.trim() : '';
    const acc = finiteNumber(req.body?.acc);
    const valve = req.body?.valve;
    const mcu = finiteNumber(req.body?.mcu);
    const voltage = finiteNumber(req.body?.voltage);
    const reportTime = parseReportTime(req.body?.reportTime);

    if (!meterNo || !/^[A-Za-z0-9_-]{1,64}$/.test(meterNo)) {
      return apiError(res, 400, 400, 'meterNo 必须是 1-64 位字母、数字、下划线或短横线');
    }
    if (acc === null || acc < 0) return apiError(res, 400, 400, 'acc 必须是大于或等于 0 的数字');
    if (valve !== '开阀' && valve !== '关阀') return apiError(res, 400, 400, 'valve 只能是“开阀”或“关阀”');
    if (req.body?.mcu !== undefined && (mcu === null || !Number.isInteger(mcu))) {
      return apiError(res, 400, 400, 'mcu 必须是整数');
    }
    if (req.body?.voltage !== undefined && (voltage === null || voltage < 0)) {
      return apiError(res, 400, 400, 'voltage 必须是大于或等于 0 的数字');
    }
    if (!reportTime) return apiError(res, 400, 400, 'reportTime 格式必须为 yyyy-MM-dd HH:mm:ss');

    const pointResult = await query(
      `SELECT pp.id, pp.project_id, pp.name, pp.insname, pp.propertyno
       FROM project_points pp
       WHERE BTRIM(COALESCE(pp.device_code, '')) = $1 AND pp.status = 'ACTIVE'
       ORDER BY pp.id`,
      [meterNo]
    );
    if (pointResult.rows.length === 0) return apiError(res, 404, 404, '水表尚未在点位管理中登记，请检查设备地址');

    if (pointResult.rows.length > 1) return apiError(res, 409, 409, '同一设备地址匹配到多个点位，请检查点位配置');
    const point = pointResult.rows[0];

    const requestId = randomUUID();
    const inserted = await query(`
      INSERT INTO meter_readings
        (request_id, meter_no, project_id, point_id, acc, valve, mcu, voltage, report_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (meter_no, report_time) DO NOTHING
      RETURNING id, request_id
    `, [requestId, meterNo, point.project_id, point.id, acc, valve, mcu, voltage, reportTime]);

    if (inserted.rows.length === 0) {
      const existing = await query(
        'SELECT id, request_id FROM meter_readings WHERE meter_no = $1 AND report_time = $2',
        [meterNo, reportTime]
      );
      return res.status(200).json({
        success: true, code: 0, msg: '成功',
        data: { requestId: existing.rows[0]?.request_id, readingId: existing.rows[0]?.id, duplicate: true }
      });
    }

    // 数据接收表保留完整原始字段；数据采集表只写累计用水量。
    const telemetryPoints: any[] = [
      { pointName: point.name, insname: point.insname || meterNo, propertyno: point.propertyno || '', paraname: '累计用水量', value: acc }
    ];

    try {
      const values: any[] = [];
      const rows = telemetryPoints.map((item, index) => {
        const offset = index * 11;
        values.push('', meterNo, item.pointName, item.insname, item.propertyno, item.paraname, 1, String(item.value), reportTime, point.project_id, point.id);
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11})`;
      });
      await query(`
        INSERT INTO telemetry_data
          (gateway_sncode, device_code, point_name, insname, propertyno, paraname, quality, value, ts, project_id, point_id)
        VALUES ${rows.join(',')}
      `, values);
      distributeData('', [{
        insname: point.insname || meterNo,
        propertyno: point.propertyno || '',
        value: acc
      }], reportTime, Number(point.project_id)).catch((error) => console.error('Meter data distribution failed:', error));
    } catch (error) {
      await query('DELETE FROM meter_readings WHERE request_id = $1', [requestId]);
      throw error;
    }

    return res.status(200).json({
      success: true, code: 0, msg: '成功',
      data: { requestId, readingId: inserted.rows[0].id, duplicate: false, meterNo, pointId: point.id, pointName: point.name }
    });
  } catch (error) {
    console.error('Receive water meter data failed:', error);
    return apiError(res, 500, 500, '数据接收失败');
  }
});

router.get('/readings', verifyUserToken, async (req: Request, res: Response) => {
  try {
    await ensureMeterSchema();
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
      conditions.push('mr.project_id IN (SELECT id FROM project_tree)');
    }
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      conditions.push(`(mr.meter_no ILIKE ${p} OR COALESCE(pp.name, '') ILIKE ${p} OR COALESCE(pr.name, '') ILIKE ${p} OR COALESCE(pr.code, '') ILIKE ${p})`);
    }
    if (start) { params.push(start); conditions.push(`mr.report_time >= $${params.length}`); }
    if (end) { params.push(end); conditions.push(`mr.report_time <= $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const from = `FROM meter_readings mr
      LEFT JOIN project_points pp ON pp.id = mr.point_id
      LEFT JOIN projects pr ON pr.id = mr.project_id`;

    const summaryResult = await query(`${cte}
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE mr.received_at >= date_trunc('day', CURRENT_TIMESTAMP))::int AS today,
        COUNT(DISTINCT mr.meter_no)::int AS meter_count,
        MAX(mr.received_at) AS latest_received_at
      ${from} ${where}`, params);

    const listParams = [...params, pageSize, (page - 1) * pageSize];
    const listResult = await query(`${cte}
      SELECT mr.id, mr.request_id, mr.meter_no, mr.acc, mr.valve, mr.mcu, mr.voltage,
        mr.report_time, mr.received_at, pp.name AS device_name,
        pr.id AS project_id, pr.code AS project_code, pr.name AS project_name
      ${from} ${where}
      ORDER BY mr.received_at DESC, mr.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, listParams);

    const summary = summaryResult.rows[0];
    return res.json({ success: true, code: 0, data: listResult.rows, total: summary.total, summary });
  } catch (error) {
    console.error('Fetch water meter readings failed:', error);
    return apiError(res, 500, 500, '查询水表数据失败');
  }
});

export default router;
