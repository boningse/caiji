import express, { Request, Response } from 'express';
import { query } from '../db.js';
import { verifyUserToken } from './auth.js';

const router = express.Router();

router.use(verifyUserToken);

const normalizeProjectCode = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const validateProjectCode = async (value: unknown, excludeProjectId?: number): Promise<string> => {
  const normalizedCode = normalizeProjectCode(value);
  if (!normalizedCode) throw new Error('项目编号不能为空');
  if (normalizedCode.length > 64) throw new Error('项目编号不能超过64个字符');

  const params: Array<string | number> = [normalizedCode];
  let sql = `SELECT id FROM projects WHERE LOWER(BTRIM(code)) = LOWER($1)`;
  if (excludeProjectId) {
    params.push(excludeProjectId);
    sql += ` AND id <> $2`;
  }
  const duplicate = await query(`${sql} LIMIT 1`, params);
  if (duplicate.rows.length > 0) throw new Error('项目编号已存在，请更换编号');
  return normalizedCode;
};

const projectErrorResponse = (res: Response, error: unknown, fallback: string) => {
  const dbError = error as { code?: string };
  if (dbError?.code === '23505') {
    return res.status(409).json({ success: false, error: '项目编号已存在，请更换编号' });
  }
  const message = error instanceof Error ? error.message : fallback;
  const isValidationError = message.includes('项目编号');
  return res.status(isValidationError ? 400 : 500).json({ success: false, error: message });
};

const isExpectedProjectCodeError = (error: unknown): boolean => {
  const dbError = error as { code?: string };
  return dbError?.code === '23505' || (error instanceof Error && error.message.includes('项目编号'));
};

// Helper to build a project tree from flat rows
const buildProjectTree = (rows: any[], parentId: number | null = null): any[] => {
  return rows
    .filter(row => row.parent_id === parentId)
    .map(row => ({
      id: row.id.toString(),
      code: row.code || '',
      name: row.name,
      details: row.details || '',
      level: row.level,
      children: buildProjectTree(rows, row.id)
    }));
};

// Get all projects as a tree
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    let result;
    
    if (user.role === 'ADMIN') {
      result = await query('SELECT * FROM projects ORDER BY created_at DESC, id DESC');
    } else {
      const pIds = user.project_ids || [];
      if (pIds.length === 0) {
        return res.json({ success: true, data: [] });
      }
      // Fetch user's projects and their children
      // Simple approach: fetch all, then filter based on allowed ids in memory or do a recursive CTE
      // Since tree depth is 3, let's just fetch all and filter in memory to keep the tree intact, 
      // or only return nodes where id is in pIds or parent is in pIds.
      const allProjects = await query('SELECT * FROM projects ORDER BY created_at DESC, id DESC');
      
      const isAllowed = (pId: number): boolean => {
        if (pIds.includes(pId)) return true;
        const p = allProjects.rows.find(x => x.id === pId);
        if (p && p.parent_id) return isAllowed(p.parent_id);
        return false;
      };
      
      const allowedRows = allProjects.rows.filter(row => isAllowed(row.id));
      result = { rows: allowedRows };
    }
    
    const tree = buildProjectTree(result.rows, null);
    res.json({ success: true, data: tree });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch projects' });
  }
});

// Create a new project
router.post('/', async (req: Request, res: Response) => {
  const { parent_id, code, name, details, level } = req.body;
  try {
    if (level < 1 || level > 3) {
      return res.status(400).json({ success: false, error: 'Level must be between 1 and 3' });
    }

    const parentIdValue = parent_id ? parseInt(parent_id, 10) : null;
    const normalizedCode = await validateProjectCode(code);
    
    const result = await query(
      'INSERT INTO projects (parent_id, code, name, details, level) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [parentIdValue, normalizedCode, name, details, level]
    );
    
    res.json({ success: true, message: 'Project created', data: result.rows[0] });
  } catch (error) {
    if (!isExpectedProjectCodeError(error)) console.error('Error creating project:', error);
    return projectErrorResponse(res, error, 'Failed to create project');
  }
});

// Edit a project
router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { code, name, details } = req.body;
  try {
    const projectId = parseInt(id, 10);
    const normalizedCode = await validateProjectCode(code, projectId);
    const result = await query(
      'UPDATE projects SET code = $1, name = $2, details = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
      [normalizedCode, name, details, projectId]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    
    res.json({ success: true, message: 'Project updated', data: result.rows[0] });
  } catch (error) {
    if (!isExpectedProjectCodeError(error)) console.error('Error updating project:', error);
    return projectErrorResponse(res, error, 'Failed to update project');
  }
});

// Delete a project (CASCADE handles children)
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await query('DELETE FROM projects WHERE id = $1', [parseInt(id, 10)]);
    res.json({ success: true, message: 'Project deleted' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ success: false, error: 'Failed to delete project' });
  }
});

export default router;
