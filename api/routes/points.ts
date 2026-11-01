import express, { Request, Response } from 'express';
import { query } from '../db.js';
import { verifyUserToken } from './auth.js';
import multer from 'multer';
import * as XLSX from 'xlsx';

const router = express.Router();
router.use(verifyUserToken);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const CN_HEADERS: Record<string, string> = {
  name: '点位名称',
  insname: 'insname',
  propertyno: 'propertyno',
  device_code: '设备地址',
  gateway_sncode: '网关SN',
  status: '状态',
};

const EXCEL_FIELDS = ['name', 'insname', 'propertyno', 'device_code', 'gateway_sncode', 'status'];

// List points
router.get('/', async (req: Request, res: Response) => {
  try {
    const { project_id, page = '1', pageSize = '10', q } = req.query as {
      project_id?: string; page?: string; pageSize?: string; q?: string;
    };
    const pageNum = Math.max(parseInt(page as string, 10) || 1, 1);
    const sizeNum = Math.min(Math.max(parseInt(pageSize as string, 10) || 10, 1), 200);
    const offset = (pageNum - 1) * sizeNum;

    let cte = '';
    let baseSql = " FROM project_points pp LEFT JOIN projects p ON p.id = pp.project_id WHERE 1=1";
    const params: any[] = [];
    let idx = 1;

    if (project_id) {
      const projectId = parseInt(project_id, 10);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, error: '无效的 project_id' });
      }
      params.push(projectId);
      cte = `WITH RECURSIVE project_tree AS (
        SELECT id FROM projects WHERE id = $${idx}
        UNION
        SELECT child.id FROM projects child
        INNER JOIN project_tree parent ON child.parent_id = parent.id
      )`;
      idx++;
      baseSql += " AND pp.project_id IN (SELECT id FROM project_tree)";
    }
    if (q && q.trim()) {
      baseSql += " AND (COALESCE(p.code,'') ILIKE $" + idx + " OR COALESCE(p.name,'') ILIKE $" + idx + " OR COALESCE(pp.name,'') ILIKE $" + idx + " OR COALESCE(pp.insname,'') ILIKE $" + idx + " OR COALESCE(pp.propertyno,'') ILIKE $" + idx + ")";
      params.push("%" + q.trim() + "%"); idx++;
    }

    const countSql = cte + " SELECT COUNT(*) AS total" + baseSql;
    const rowsSql = cte + " SELECT pp.*, p.name AS project_name, p.code AS project_code" + baseSql + " ORDER BY pp.created_at DESC LIMIT $" + idx + " OFFSET $" + (idx + 1);
    const rowsParams = params.concat([sizeNum, offset]);

    const [countRes, rowsRes] = await Promise.all([query(countSql, params), query(rowsSql, rowsParams)]);
    const total = parseInt(countRes.rows[0]?.total || '0', 10);
    res.json({ success: true, data: rowsRes.rows, pagination: { total, page: pageNum, pageSize: sizeNum } });
  } catch (e) {
    console.error('List points error:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch points' });
  }
});

// Export Excel
router.get('/export', async (req: Request, res: Response) => {
  try {
    const { project_id } = req.query as { project_id?: string };
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id 必填' });

    const rowsRes = await query(
      "SELECT pp.name, pp.insname, pp.propertyno, pp.device_code, pp.gateway_sncode, COALESCE(pp.status, 'ACTIVE') AS status FROM project_points pp WHERE pp.project_id = $1 ORDER BY pp.created_at DESC",
      [parseInt(project_id, 10)]
    );

    const excelRows = rowsRes.rows.map((r: any) => {
      const row: Record<string, string> = {};
      for (const f of EXCEL_FIELDS) row[CN_HEADERS[f] || f] = r[f] || '';
      return row;
    });

    const ws = XLSX.utils.json_to_sheet(excelRows);
    ws['!cols'] = EXCEL_FIELDS.map(() => ({ wch: 20 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '点位列表');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('点位列表.xlsx'));
    res.send(buf);
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ success: false, error: 'Failed to export' });
  }
});

// Download template
router.get('/template', async (_req: Request, res: Response) => {
  try {
    const templateRow: Record<string, string> = {};
    for (const f of EXCEL_FIELDS) templateRow[CN_HEADERS[f] || f] = '';
    const ws = XLSX.utils.json_to_sheet([templateRow]);
    ws['!cols'] = EXCEL_FIELDS.map(() => ({ wch: 22 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '点位导入模板');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('点位导入模板.xlsx'));
    res.send(buf);
  } catch (e) {
    console.error('Template error:', e);
    res.status(500).json({ success: false, error: 'Failed to generate template' });
  }
});

// Excel import
router.post('/bulk-xlsx', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const project_id = req.body.project_id ? parseInt(req.body.project_id, 10) : null;
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id 必填' });
    const uploadedFile = (req as Request & { file?: { buffer: Buffer } }).file;
    if (!uploadedFile) return res.status(400).json({ success: false, error: '请上传 Excel 文件' });

    const wb = XLSX.read(uploadedFile.buffer, { type: 'buffer' });
    const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    if (rows.length === 0) return res.status(400).json({ success: false, error: 'Excel 文件中没有数据行' });

    const reverseMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(CN_HEADERS)) reverseMap[v] = k;

    let success = 0, failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const mapped: Record<string, string> = {};
      for (const [key, val] of Object.entries(raw)) {
        mapped[reverseMap[key] || key] = String(val ?? '').trim();
      }

      if (!mapped.name) { failed++; errors.push("第 " + (i + 2) + " 行: 点位名称为空"); continue; }

      try {
        await query(
          "INSERT INTO project_points (project_id, name, insname, propertyno, device_code, gateway_sncode, status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (project_id, COALESCE(insname,'')) DO UPDATE SET name = EXCLUDED.name, propertyno = EXCLUDED.propertyno, device_code = EXCLUDED.device_code, gateway_sncode = EXCLUDED.gateway_sncode, status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP",
          [project_id, mapped.name, mapped.insname || null, mapped.propertyno || null, mapped.device_code || null, mapped.gateway_sncode || null, mapped.status || 'ACTIVE']
        );
        success++;
      } catch (e: any) {
        failed++;
        errors.push("第 " + (i + 2) + " 行: " + (e.message || '导入失败'));
      }
    }
    res.json({ success: true, data: { success, failed, errors: errors.slice(0, 20) } });
  } catch (e) {
    console.error('Excel import error:', e);
    res.status(500).json({ success: false, error: 'Failed to import Excel' });
  }
});

// Bulk JSON import (kept for compatibility)
router.post('/bulk', async (req: Request, res: Response) => {
  try {
    const { rows, project_id } = req.body as { rows: any[]; project_id?: number };
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ success: false, error: 'rows 不能为空' });
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id 必填' });
    let success = 0, failed = 0;
    for (const r of rows) {
      try {
        await query(
          "INSERT INTO project_points (project_id, name, insname, propertyno, device_code, gateway_sncode, status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (project_id, COALESCE(insname,'')) DO UPDATE SET name = EXCLUDED.name, propertyno = EXCLUDED.propertyno, device_code = EXCLUDED.device_code, gateway_sncode = EXCLUDED.gateway_sncode, status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP",
          [project_id, r.name, r.insname || null, r.propertyno || null, r.device_code || null, r.gateway_sncode || null, r.status || 'ACTIVE']
        );
        success++;
      } catch (e) { console.error('Import row error:', e); failed++; }
    }
    res.json({ success: true, data: { success, failed } });
  } catch (e) {
    console.error('Bulk import error:', e);
    res.status(500).json({ success: false, error: 'Failed to import points' });
  }
});

// Delete by project
router.delete('/by-project/:projectId', async (req: Request, res: Response) => {
  try {
    const pid = parseInt(req.params.projectId, 10);
    if (!pid) return res.status(400).json({ success: false, error: '无效的 projectId' });
    const del = await query('DELETE FROM project_points WHERE project_id = $1', [pid]);
    res.json({ success: true, data: { deleted: del.rowCount || 0 }});
  } catch (e) { console.error('Delete by project error:', e); res.status(500).json({ success: false, error: 'Failed to delete points by project' }); }
});

// Create
router.post('/', async (req: Request, res: Response) => {
  const { project_id, name, insname, propertyno, device_code, gateway_sncode, status } = req.body;
  try {
    if (!project_id || !name) return res.status(400).json({ success: false, error: 'project_id 和 name 必填' });
    const result = await query(
      "INSERT INTO project_points (project_id, name, insname, propertyno, device_code, gateway_sncode, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [project_id, name, insname || null, propertyno || null, device_code || null, gateway_sncode || null, status || 'ACTIVE']
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (e: any) {
    console.error('Create point error:', e);
    if (e.code === '23505') return res.status(400).json({ success: false, error: '相同匹配条件的点位已存在' });
    res.status(500).json({ success: false, error: 'Failed to create point' });
  }
});

// Update
router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, insname, propertyno, device_code, gateway_sncode, status } = req.body;
  try {
    const result = await query(
      "UPDATE project_points SET name = $1, insname = $2, propertyno = $3, device_code = $4, gateway_sncode = $5, status = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7 RETURNING *",
      [name, insname || null, propertyno || null, device_code || null, gateway_sncode || null, status || 'ACTIVE', parseInt(id, 10)]
    );
    if (result.rowCount === 0) return res.status(404).json({ success: false, error: 'Point not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (e) { console.error('Update point error:', e); res.status(500).json({ success: false, error: 'Failed to update point' }); }
});

// Delete
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await query('DELETE FROM project_points WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ success: true, message: 'Point deleted' });
  } catch (e) { console.error('Delete point error:', e); res.status(500).json({ success: false, error: 'Failed to delete point' }); }
});

export default router;
