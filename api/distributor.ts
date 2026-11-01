import { Pool as PgPool, PoolConfig as PgPoolConfig } from 'pg';
import format from 'pg-format';
import mysql from 'mysql2/promise';
import { query as localQuery } from './db.js';
import { getGatewayProjectIds } from './gateway-projects.js';

interface Distribution {
  id: number;
  project_id: number;
  target_db_type: string;
  target_db_config: any;
  start_time: string | null;
}

const pgPools = new Map<number, PgPool>();
const mysqlPools = new Map<number, mysql.Pool>();

function getPgPool(distId: number, config: any): PgPool {
  if (pgPools.has(distId)) {
    return pgPools.get(distId)!;
  }
  
  const poolConfig: PgPoolConfig = {
    host: config.host,
    port: parseInt(config.port || '5432'),
    user: config.user,
    password: config.password,
    database: config.database,
    max: 50, // 提升外部 DB 分发连接池大小以应对高吞吐
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
  
  const pool = new PgPool(poolConfig);
  pool.on('error', (err) => {
    console.error(`PostgreSQL distribution pool ${distId} error:`, err);
  });
  
  pgPools.set(distId, pool);
  return pool;
}

function getMysqlPool(distId: number, config: any): mysql.Pool {
  if (mysqlPools.has(distId)) {
    return mysqlPools.get(distId)!;
  }
  
  const pool = mysql.createPool({
    host: config.host,
    port: parseInt(config.port || '3306'),
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 50, // 提升 MySQL 连接池限制
    queueLimit: 0
  });
  
  mysqlPools.set(distId, pool);
  return pool;
}

export async function distributeData(gatewaySncode: string, records: any[], ts: Date, projectIdOverride?: number) {
  if (!records || records.length === 0) return;

  try {
    // 4G 直传设备仍使用点位项目；网关数据则完整复制到全部绑定项目。
    const projectIds = projectIdOverride
      ? [projectIdOverride]
      : await getGatewayProjectIds(gatewaySncode);
    for (const projectId of Array.from(new Set(projectIds))) {
      await distributeProjectData(projectId, records, ts);
    }
  } catch (error) {
    console.error('Error in distributeData:', error);
  }
}

async function distributeProjectData(projectId: number, records: any[], ts: Date, distributionId?: number) {
  try {
    // 2. 找到所有匹配该项目的活动的分发配置
    const distResult = await localQuery(
      `SELECT id, project_ids, target_db_type, target_db_config, start_time
       FROM data_distributions
       WHERE $1 = ANY(project_ids) AND status = 'ACTIVE'
         AND ($2::int IS NULL OR id = $2)`,
      [projectId, distributionId || null]
    );
    
    if (distResult.rowCount === 0) return;
    
    // 获取项目编号，用于表名拼接
    const projResult = await localQuery('SELECT code FROM projects WHERE id = $1', [projectId]);
    const projectCode = projResult.rowCount && projResult.rows[0].code ? projResult.rows[0].code : `proj_${projectId}`;
    
    // 恢复为按年月生成目标分发库表名
    const dateObj = new Date(ts);
    const yearMonth = `${dateObj.getFullYear()}${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
    const tableName = `${yearMonth}_recorddata_${projectCode}`;

    // 严格过滤：只保留真正有效的数值
    const validRecords = records.filter(r => {
      if (r.value === null || r.value === undefined) return false;
      const strValue = String(r.value).trim();
      if (strValue === '' || strValue === 'null' || strValue === 'undefined' || strValue === 'NaN') return false;
      const numValue = parseFloat(strValue);
      return !isNaN(numValue) && isFinite(numValue);
    });
    const distData = validRecords.map(r => [
      r.insname || '',
      r.propertyno ? parseInt(r.propertyno, 10) || 0 : 0, // propertyno 对应 funcid
      formatDate(ts),
      parseFloat(String(r.value).trim()),
      1 // virtual 默认1
    ]);
    
    // 如果没有有效数据，直接返回
    if (validRecords.length === 0) return;
    
    // 3. 执行分发
    for (const dist of distResult.rows as Distribution[]) {
      if (dist.target_db_type === 'postgresql') {
        try {
          const pool = getPgPool(dist.id, dist.target_db_config);

          // 确保目标表存在及主键约束，用于支持 upsert
          // 取消为第三方库建 timescaledb 扩展，因表名带月份后缀，不需要超表
          await pool.query(`
            CREATE TABLE IF NOT EXISTS "${tableName}" (
              "sign" VARCHAR(64),
              "funcid" INT,
              "receivetime" TIMESTAMP,
              "data" NUMERIC,
              "virtual" SMALLINT,
              PRIMARY KEY ("sign", "funcid", "receivetime")
            );
          `);
          
          // 批量插入 (UPSERT)，存在则更新，避免报错或重复
          const insertQuery = format(
            `INSERT INTO "${tableName}" (sign, funcid, receivetime, data, virtual) VALUES %L ON CONFLICT (sign, funcid, receivetime) DO UPDATE SET data = EXCLUDED.data, virtual = EXCLUDED.virtual`, 
            distData
          );
          await pool.query(insertQuery);
          
        } catch (e: any) {
          console.error(`Failed to distribute data to PG for distribution ${dist.id}:`, e.message || e);
        }
      } else if (dist.target_db_type === 'mysql') {
        try {
          const pool = getMysqlPool(dist.id, dist.target_db_config);
          
          // 确保目标表存在及主键约束 (MySQL 语法)
          await pool.query(`
            CREATE TABLE IF NOT EXISTS \`${tableName}\` (
              \`sign\` VARCHAR(64),
              \`funcid\` INT,
              \`receivetime\` DATETIME,
              \`data\` DOUBLE,
              \`virtual\` TINYINT,
              PRIMARY KEY (\`sign\`, \`funcid\`, \`receivetime\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8;
          `);
          
          // 批量插入 (MySQL UPSERT: INSERT ... ON DUPLICATE KEY UPDATE)
          if (distData.length > 0) {
            await pool.query(
              `INSERT INTO \`${tableName}\` (sign, funcid, receivetime, data, virtual) VALUES ? 
               ON DUPLICATE KEY UPDATE data = VALUES(data), virtual = VALUES(virtual)`, 
              [distData]
            );
          }
          
        } catch (e: any) {
          console.error(`Failed to distribute data to MySQL for distribution ${dist.id}:`, e.message || e);
        }
      } else if (dist.target_db_type === 'api') {
        try {
          const config = dist.target_db_config;
          const url = config.url;
          const method = config.method || 'POST';
          const headers = config.headers || {};
          
          // 将数据格式化为 JSON 发送（只发送有效记录）
          const payload = validRecords.map(r => ({
            sign: r.insname || '',
            funcid: r.propertyno ? parseInt(r.propertyno, 10) || 0 : 0,
            receivetime: formatDate(ts),
            data: parseFloat(r.value),
            virtual: 1
          }));

          fetch(url, {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...headers
            },
            body: JSON.stringify(payload)
          }).catch(err => console.error(`API Distribution ${dist.id} failed:`, err));
        } catch (e) {
          console.error(`API Distribution config error ${dist.id}:`, e);
        }
      }
    }
  } catch (error) {
    console.error(`Error distributing project ${projectId}:`, error);
  }
}

export async function distributeDataForDist(
  distId: number,
  gatewaySncode: string,
  records: any[],
  ts: Date,
  projectIdOverride?: number
) {
  if (!records || records.length === 0) return;
  try {
    const distRes = await localQuery(
      `SELECT id, project_ids, target_db_type, target_db_config, start_time 
       FROM data_distributions WHERE id = $1 AND status = 'ACTIVE'`,
      [distId]
    );
    if (distRes.rowCount === 0) return;
    const dist = distRes.rows[0] as Distribution & { project_ids: number[] };
    if (dist.start_time) {
      const startTime = new Date(dist.start_time);
      if (ts < startTime) return;
    }
    const boundProjectIds = projectIdOverride
      ? [projectIdOverride]
      : await getGatewayProjectIds(gatewaySncode);
    const distributionProjectIds = new Set((dist.project_ids || []).map(Number));
    for (const projectId of boundProjectIds.filter((id) => distributionProjectIds.has(id))) {
      await distributeProjectData(projectId, records, ts, distId);
    }
  } catch (e) {
    console.error('distributeDataForDist error:', e);
  }
}

function formatDate(date: Date): string {
  // 修正时差：加上 8 小时 (北京时间 UTC+8)
  const beijingTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const d = beijingTime.getUTCDate().toString().padStart(2, '0');
  const m = (beijingTime.getUTCMonth() + 1).toString().padStart(2, '0');
  const y = beijingTime.getUTCFullYear();
  const hh = beijingTime.getUTCHours().toString().padStart(2, '0');
  const mm = beijingTime.getUTCMinutes().toString().padStart(2, '0');
  const ss = beijingTime.getUTCSeconds().toString().padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}
