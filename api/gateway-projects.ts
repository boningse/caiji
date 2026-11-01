import type { PoolClient } from 'pg';
import { query } from './db.js';

interface ProjectRow {
  id: number;
  parent_id: number | null;
  level: number;
}

const toPositiveInt = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export async function validateGatewayProjectSelection(
  primaryProjectIdRaw: unknown,
  associatedProjectIdsRaw: unknown,
): Promise<{ primaryProjectId: number; associatedProjectIds: number[] }> {
  const primaryProjectId = toPositiveInt(primaryProjectIdRaw);
  if (!primaryProjectId) throw new Error('必须选择主项目');

  const associatedProjectIds = Array.from(new Set(
    (Array.isArray(associatedProjectIdsRaw) ? associatedProjectIdsRaw : [])
      .map(toPositiveInt)
      .filter((id): id is number => id !== null && id !== primaryProjectId),
  ));

  const projectResult = await query('SELECT id, parent_id, level FROM projects');
  const projects = new Map<number, ProjectRow>(
    projectResult.rows.map((row) => [Number(row.id), {
      id: Number(row.id),
      parent_id: row.parent_id === null ? null : Number(row.parent_id),
      level: Number(row.level),
    }]),
  );
  const primary = projects.get(primaryProjectId);
  if (!primary) throw new Error('所选主项目不存在');

  const getRootProjectId = (projectId: number): number => {
    let current = projects.get(projectId);
    const visited = new Set<number>();
    while (current?.parent_id) {
      if (visited.has(current.id)) throw new Error('项目层级关系异常');
      visited.add(current.id);
      current = projects.get(current.parent_id);
      if (!current) throw new Error('项目层级关系异常');
    }
    return current?.id || projectId;
  };
  const primaryRootProjectId = getRootProjectId(primaryProjectId);

  for (const projectId of associatedProjectIds) {
    const project = projects.get(projectId);
    if (!project || (project.level !== 2 && project.level !== 3)) {
      throw new Error('关联项目只能选择二级或三级项目');
    }
    if (getRootProjectId(projectId) !== primaryRootProjectId) {
      throw new Error('关联项目必须与主项目属于同一项目树');
    }
  }

  return { primaryProjectId, associatedProjectIds };
}

export async function replaceGatewayProjectBindings(
  client: PoolClient,
  gatewaySncode: string,
  primaryProjectId: number,
  associatedProjectIds: number[],
) {
  await client.query('DELETE FROM gateway_project_bindings WHERE gateway_sncode = $1', [gatewaySncode]);
  await client.query(
    `INSERT INTO gateway_project_bindings (gateway_sncode, project_id, binding_type)
     VALUES ($1, $2, 'PRIMARY')`,
    [gatewaySncode, primaryProjectId],
  );
  if (associatedProjectIds.length > 0) {
    await client.query(
      `INSERT INTO gateway_project_bindings (gateway_sncode, project_id, binding_type)
       SELECT $1, project_id, 'SHARED'
       FROM unnest($2::int[]) AS project_id`,
      [gatewaySncode, associatedProjectIds],
    );
  }
}

export async function getGatewayProjectIds(gatewaySncode: string): Promise<number[]> {
  try {
    const bindingResult = await query(
      `SELECT project_id
       FROM gateway_project_bindings
       WHERE gateway_sncode = $1
       ORDER BY CASE binding_type WHEN 'PRIMARY' THEN 0 ELSE 1 END, project_id`,
      [gatewaySncode],
    );
    if (bindingResult.rows.length > 0) {
      return Array.from(new Set(bindingResult.rows.map((row) => Number(row.project_id))));
    }
  } catch (error) {
    console.error('Load gateway project bindings failed, falling back to primary project:', error);
  }

  const gatewayResult = await query('SELECT project_id FROM gateway_info WHERE sncode = $1', [gatewaySncode]);
  const projectId = gatewayResult.rows?.[0]?.project_id;
  return projectId ? [Number(projectId)] : [];
}
