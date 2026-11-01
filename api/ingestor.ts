import { query } from './db.js';
import { distributeData } from './distributor.js';
import { getGatewayProjectIds } from './gateway-projects.js';

/**
 * Shared ingestion logic for V3/V4 Data Push from both MQTT and Webhook
 * Uses the unified telemetry_data hypertable
 */
export async function ingestData(sncode: string, dev: any, time?: number) {
  const ts = time ? new Date(time * 1000) : new Date();

  try {
    // Update gateway online status
    await query(
      "UPDATE gateway_info SET status = 'ONLINE', last_online_time = CURRENT_TIMESTAMP WHERE sncode = $1 AND (status != 'ONLINE' OR last_online_time IS NULL OR last_online_time < CURRENT_TIMESTAMP - interval '1 minute')",
      [sncode]
    );

    const values: any[] = [];
    const tableName = `telemetry_data`;
    const gatewayProjectIds = await getGatewayProjectIds(sncode);
    const targetProjectIds: Array<number | null> = gatewayProjectIds.length > 0 ? gatewayProjectIds : [null];

    let queryText = `INSERT INTO ${tableName} (gateway_sncode, device_code, point_name, insname, propertyno, paraname, quality, value, ts, project_id, point_id) VALUES `;
    let paramIndex = 1;

    let pointMap: Map<string, string> | null = null;
    try {
      if (gatewayProjectIds.length > 0) {
        const pp = await query(
          "SELECT name, COALESCE(insname,'') insname, COALESCE(propertyno,'') propertyno, COALESCE(device_code,'') device_code, COALESCE(gateway_sncode,'') gateway_sncode FROM project_points WHERE (project_id = ANY($1::int[]) OR gateway_sncode = $2) AND status = 'ACTIVE' ORDER BY project_id, id",
          [gatewayProjectIds, sncode]
        );
        const norm = (v: any) => (v ?? '').toString().trim();
        const starToEmpty = (s: string) => (s === '*' ? '' : s);
        const normProp = (v: any) => {
          const s = norm(v);
          if (s === '*') return '';
          if (s === '') return '';
          const t = s.replace(/^0+/, '');
          return t === '' ? '0' : t;
        };
        pointMap = new Map();
        for (const r of pp.rows) {
          const ni = starToEmpty(norm(r.insname));
          const np = normProp(r.propertyno);
          const nd = starToEmpty(norm(r.device_code));
          const ns = starToEmpty(norm(r.gateway_sncode));
          const keys = new Set<string>([
            `${ni}|${np}|${nd}|${ns}`,
            `${ni}|||${ns}`,
            `${ni}|${np}||${ns}`,
            `|${np}||${ns}`,
            `|${np}|${nd}|${ns}`,
            `${ni}|${np}|${nd}|`
          ]);
          for (const k of keys) {
            if (!pointMap.has(k)) pointMap.set(k, r.name);
          }
        }
      }
    } catch (e) {
      console.error('Load project points failed:', e);
    }

    const resolvePointName = (insname?: string, propertyno?: string, deviceCode?: string) => {
      if (!pointMap) return '';
      const norm = (v: any) => (v ?? '').toString().trim();
      const starToEmpty = (s: string) => (s === '*' ? '' : s);
      const normProp = (v: any) => {
        const s = norm(v);
        if (s === '*') return '';
        if (s === '') return '';
        const t = s.replace(/^0+/, '');
        return t === '' ? '0' : t;
      };
      const ni = starToEmpty(norm(insname));
      const np = normProp(propertyno);
      const nd = starToEmpty(norm(deviceCode));
      const ns = starToEmpty(norm(sncode));
      const keyCandidates = [
        `${ni}|||${ns}`,
        `${ni}|${np}||${ns}`,
        `|${np}||${ns}`,
        `${ni}|${np}|${nd}|${ns}`,
        `${ni}|${np}|${nd}|`,
        `|${np}|${nd}|${ns}`
      ];
      for (const k of keyCandidates) {
        const v = pointMap.get(k);
        if (v) return v;
      }
      return '';
    };

    const recordsToDistribute: any[] = [];

    if (Array.isArray(dev)) {
      for (const pt of dev) {
        const valStr = pt.value === null ? '' : String(pt.value);
        const pName = resolvePointName(pt.insname || pt.pn, pt.propertyno, pt.dev || '');
        for (const projectId of targetProjectIds) {
          queryText += `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}), `;
          values.push(sncode, pt.dev || '', pName || pt.insname || pt.propertyno || '', pt.insname || '', pt.propertyno || '', pt.paraname || '', pt.quality || 0, valStr, ts, projectId, null);
        }
        recordsToDistribute.push(pt);
      }
    } else {
      for (const [deviceCode, points] of Object.entries(dev)) {
        const pointsArray = points as Array<{ pn: string; q: number; v: string; propertyno?: string; insname?: string }>;
        for (const pt of pointsArray) {
          if (pt.q === 1) {
            const pName = resolvePointName(pt.insname || pt.pn, pt.propertyno, deviceCode);
            for (const projectId of targetProjectIds) {
              queryText += `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}), `;
              values.push(sncode, deviceCode, pName || pt.pn, pt.insname || pt.pn || '', pt.propertyno || '', '', pt.q, pt.v, ts, projectId, null);
            }
            recordsToDistribute.push({
              insname: pt.insname || pt.pn,
              propertyno: pt.propertyno || '',
              value: pt.v
            });
          }
        }
      }
    }

    if (values.length > 0) {
      queryText = queryText.slice(0, -2);
      await query(queryText, values);

      distributeData(sncode, recordsToDistribute, ts).catch(err => {
        console.error('Data distribution failed in background:', err);
      });
    }
  } catch (error) {
    console.error('Failed to ingest data:', error);
    throw error;
  }
}
