import express, { Request, Response } from 'express';
import { query } from '../db.js';
import crypto from 'crypto';
import { verifyUserToken } from './auth.js';

const router = express.Router();

router.use(verifyUserToken);

// Generate a secure random token
const generateToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Get all API tokens
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const result = await query("SELECT * FROM api_tokens WHERE COALESCE(token_type, 'GENERAL') <> 'METER_VENDOR' ORDER BY created_at DESC");
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching API tokens:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch API tokens' });
  }
});

// Create a new API token
router.post('/', async (req: Request, res: Response) => {
  const { name, project_ids, permissions } = req.body;
  try {
    const user = (req as any).user;
    if (user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const token = generateToken();
    const pIds = Array.isArray(project_ids) ? project_ids : [];
    const perms = Array.isArray(permissions) ? permissions : ['read_data'];
    
    const result = await query(
      'INSERT INTO api_tokens (name, token, project_ids, permissions) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, token, pIds, perms]
    );
    
    res.json({ success: true, message: 'API token created', data: result.rows[0] });
  } catch (error) {
    console.error('Error creating API token:', error);
    res.status(500).json({ success: false, error: 'Failed to create API token' });
  }
});

// Update an API token
router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, project_ids, permissions, status } = req.body;
  try {
    const user = (req as any).user;
    if (user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const pIds = Array.isArray(project_ids) ? project_ids : [];
    const perms = Array.isArray(permissions) ? permissions : ['read_data'];
    
    const result = await query(
      "UPDATE api_tokens SET name = $1, project_ids = $2, permissions = $3, status = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 AND COALESCE(token_type, 'GENERAL') <> 'METER_VENDOR' RETURNING *",
      [name, pIds, perms, status, parseInt(id, 10)]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'API token not found' });
    }
    
    res.json({ success: true, message: 'API token updated', data: result.rows[0] });
  } catch (error) {
    console.error('Error updating API token:', error);
    res.status(500).json({ success: false, error: 'Failed to update API token' });
  }
});

// Delete an API token
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const user = (req as any).user;
    if (user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const result = await query("DELETE FROM api_tokens WHERE id = $1 AND COALESCE(token_type, 'GENERAL') <> 'METER_VENDOR' RETURNING id", [parseInt(id, 10)]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'API token not found' });
    }
    res.json({ success: true, message: 'API token deleted' });
  } catch (error) {
    console.error('Error deleting API token:', error);
    res.status(500).json({ success: false, error: 'Failed to delete API token' });
  }
});

export default router;
