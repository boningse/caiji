import { Pool } from 'pg';

// Using connection pool for OpenGauss (PostgreSQL compatible)
const pool = new Pool({
  user: process.env.DB_USER || 'omm',
  host: process.env.DB_HOST || '127.0.0.1',
  database: process.env.DB_NAME || 'postgres',
  password: process.env.DB_PASSWORD || 'BoNing@123',
  port: parseInt(process.env.DB_PORT || '5432'),
  max: 40, // PostgreSQL max_connections 为 100，限制应用池以给维护与其他客户端保留余量
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // 增加连接超时时间，防止瞬间突发打满时报错
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  // 不要直接 process.exit，防止偶尔的网络波动导致整个服务挂掉，让 PM2 或 Docker 重试
});

export const query = (text: string, params?: any[]) => pool.query(text, params);
export const getClient = () => pool.connect();
