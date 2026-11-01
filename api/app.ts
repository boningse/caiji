/**
 * This is a API server
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import cors from 'cors'
import path from 'path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import fs from 'fs'
import authRoutes from './routes/auth.js'
import webhookRoutes from './routes/webhook.js'
import gatewaysRoutes from './routes/gateways.js'
import projectsRoutes from './routes/projects.js'
import apiTokensRoutes from './routes/api_tokens.js'
import sharedRoutes from './routes/shared.js'
import usersRoutes from './routes/users.js'
import distributionsRoutes from './routes/distributions.js'
import deviceTypesRoutes from './routes/device_types.js'
import pointsRoutes from './routes/points.js'
import meterRoutes from './routes/meter.js'
import electricalRoutes from './routes/electrical.js'
import environmentMonitorRoutes from './routes/environment-monitor.js'
import { query } from './db.js'
import { initMqtt } from './mqtt.js'
import { initEnvironmentMonitor } from './environment-monitor.js'

// for esm mode
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// load env
dotenv.config()

// Initialize Database Schema
const initDb = async () => {
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await query(schemaSql);
    // Project codes are required and globally unique after trimming and
    // ignoring letter case. Existing clean data is normalized once so the
    // database constraint and API validation use exactly the same rule.
    try {
      await query(`UPDATE projects SET code = BTRIM(code) WHERE code IS DISTINCT FROM BTRIM(code)`);
      await query(`ALTER TABLE projects ALTER COLUMN code SET NOT NULL`);
      await query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'projects_code_not_blank'
          ) THEN
            ALTER TABLE projects
            ADD CONSTRAINT projects_code_not_blank CHECK (BTRIM(code) <> '');
          END IF;
        END $$
      `);
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_code_unique
        ON projects (LOWER(BTRIM(code)))`);
      console.log('Project code required/unique constraints ensured');
    } catch (e) {
      console.error('Failed to ensure project code constraints:', e);
    }
    // Execute alter table for publish_topic just in case table exists
    try {
      await query('ALTER TABLE gateway_info ADD COLUMN publish_topic VARCHAR(255);');
      console.log('Added publish_topic column to gateway_info');
    } catch (e: any) {
      if (e.code !== '42701') console.error('Failed to alter table:', e);
    }
    
    // Execute alter table for subscribe_topic just in case table exists
    try {
      await query('ALTER TABLE gateway_info ADD COLUMN subscribe_topic VARCHAR(255);');
      console.log('Added subscribe_topic column to gateway_info');
    } catch (e: any) {
      if (e.code !== '42701') console.error('Failed to alter table:', e);
    }

    // Record the exact time when a gateway changes from online to offline.
    try {
      await query('ALTER TABLE gateway_info ADD COLUMN last_offline_time TIMESTAMP;');
      console.log('Added last_offline_time column to gateway_info');
    } catch (e: any) {
      if (e.code !== '42701') console.error('Failed to alter gateway_info table:', e);
    }
    
    // Execute alter table for data_distributions start_time just in case
    try {
      await query('ALTER TABLE data_distributions ADD COLUMN start_time TIMESTAMP;');
      console.log('Added start_time column to data_distributions');
    } catch (e: any) {
      if (e.code !== '42701') console.error('Failed to alter table:', e);
    }

    // Execute alter table for data_distributions project_ids just in case
    try {
      await query('ALTER TABLE data_distributions ADD COLUMN project_ids INT[] NOT NULL DEFAULT \'{}\';');
      console.log('Added project_ids column to data_distributions');
      
      // Migrate old project_id to project_ids
      try {
        await query('UPDATE data_distributions SET project_ids = ARRAY[project_id] WHERE project_id IS NOT NULL AND array_length(project_ids, 1) IS NULL;');
        console.log('Migrated old project_id to project_ids');
      } catch (e) {}
    } catch (e: any) {
      if (e.code !== '42701') console.error('Failed to alter table:', e);
    }

    // Execute alter table for api_tokens permissions just in case
    try {
      await query('ALTER TABLE api_tokens ADD COLUMN permissions VARCHAR[] DEFAULT \'{read_data}\';');
      console.log('Added permissions column to api_tokens');
    } catch (e: any) {
      if (e.code !== '42701') console.error('Failed to alter table:', e);
    }

    // Ensure raw_mqtt_logs has gateway_sncode for joins and filtering
    try {
      await query('ALTER TABLE raw_mqtt_logs ADD COLUMN gateway_sncode VARCHAR(64);');
      console.log('Added gateway_sncode column to raw_mqtt_logs');
    } catch (e: any) {
      if (e.code !== '42701') console.error('Failed to alter raw_mqtt_logs table:', e);
    }
    try {
      await query('CREATE INDEX IF NOT EXISTS idx_raw_mqtt_logs_time ON raw_mqtt_logs(received_at DESC);');
    } catch (e) {
      console.error('Failed to create index on raw_mqtt_logs:', e);
    }

    // Migrate a legacy single-project gateway only when it has no primary
    // binding yet. The existing project remains its primary project regardless
    // of whether it is level 1, 2 or 3.
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS gateway_project_bindings (
          gateway_sncode VARCHAR(64) REFERENCES gateway_info(sncode) ON DELETE CASCADE,
          project_id INT REFERENCES projects(id) ON DELETE CASCADE,
          binding_type VARCHAR(16) NOT NULL DEFAULT 'SHARED'
            CHECK (binding_type IN ('PRIMARY', 'SHARED')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (gateway_sncode, project_id)
        )
      `);
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_project_one_primary
        ON gateway_project_bindings (gateway_sncode) WHERE binding_type = 'PRIMARY'`);
      await query(`CREATE INDEX IF NOT EXISTS idx_gateway_project_project
        ON gateway_project_bindings (project_id, gateway_sncode)`);
      await query(`
        INSERT INTO gateway_project_bindings (gateway_sncode, project_id, binding_type)
        SELECT g.sncode, g.project_id, 'PRIMARY'
        FROM gateway_info g
        WHERE g.project_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM gateway_project_bindings existing
            WHERE existing.gateway_sncode = g.sncode
              AND existing.binding_type = 'PRIMARY'
          )
        ON CONFLICT (gateway_sncode, project_id)
        DO UPDATE SET binding_type = 'PRIMARY'
      `);
      console.log('Gateway multi-project bindings ensured');
    } catch (e) {
      console.error('Failed to initialize gateway project bindings:', e);
    }

    // --- Initialize TimescaleDB Telemetry Hypertable ---
    try {
      // 尝试启用 timescaledb 扩展（可能需要超级用户权限，如果已启用或不支持会抛错，此处忽略）
      try {
        await query('CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;');
      } catch (e) {
        console.warn('Could not create timescaledb extension (might already exist or missing privileges/plugin).', e);
      }

      await query(`
        CREATE TABLE IF NOT EXISTS telemetry_data (
            id BIGSERIAL,
            gateway_sncode VARCHAR(64) NOT NULL,
            device_code VARCHAR(64) NOT NULL,
            point_name VARCHAR(64) NOT NULL,
            insname VARCHAR(64),
            propertyno VARCHAR(64),
            paraname VARCHAR(64),
            quality INT NOT NULL,
            value VARCHAR(255) NOT NULL,
            ts TIMESTAMP NOT NULL,
            PRIMARY KEY (id, ts)
        );
      `);

      // 将表转换为超表（按天分区）
      try {
        await query(`SELECT create_hypertable('telemetry_data', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 day');`);
        console.log('telemetry_data converted to hypertable successfully.');
      } catch (e: any) {
        // 如果不支持或已经是超表，则忽略
        console.warn('Hypertable conversion skipped or failed (might already be hypertable or not supported):', e.message);
      }

      await query('CREATE INDEX IF NOT EXISTS idx_telemetry_data_ts ON telemetry_data(ts DESC);');
      await query('CREATE INDEX IF NOT EXISTS idx_telemetry_data_sncode ON telemetry_data(gateway_sncode, ts DESC);');
      await query('ALTER TABLE telemetry_data ADD COLUMN IF NOT EXISTS project_id INT');
      await query('ALTER TABLE telemetry_data ADD COLUMN IF NOT EXISTS point_id INT');
      await query('CREATE INDEX IF NOT EXISTS idx_telemetry_data_project_time ON telemetry_data(project_id, ts DESC);');
      console.log('telemetry_data table and indexes ensured.');
    } catch (e) {
      console.error('Failed to initialize telemetry_data table:', e);
    }

    try {
      await query(`
        CREATE TABLE IF NOT EXISTS device_types (
            id SERIAL PRIMARY KEY,
            name VARCHAR(128) NOT NULL,
            code VARCHAR(64) UNIQUE NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS device_type_functions (
            id SERIAL PRIMARY KEY,
            device_type_id INT REFERENCES device_types(id) ON DELETE CASCADE,
            function_code VARCHAR(64) NOT NULL,
            function_name VARCHAR(128) NOT NULL,
            data_type VARCHAR(32),
            unit VARCHAR(32),
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(device_type_id, function_code)
        );
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS project_points (
            id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(id) ON DELETE CASCADE,
            name VARCHAR(128) NOT NULL,
            insname VARCHAR(128),
            propertyno VARCHAR(64),
            device_code VARCHAR(128),
            gateway_sncode VARCHAR(64),
            status VARCHAR(32) DEFAULT 'ACTIVE',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      // reset unique index to (project_id, insname)
      try { await query(`DROP INDEX IF EXISTS idx_project_points_unique;`); } catch (e) {}
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_points_unique_ins
        ON project_points (project_id, COALESCE(insname,''));
      `);
      console.log('Device types tables ensured');
    } catch (e) {
      console.error('Failed to ensure device types tables:', e);
    }
    
    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database schema:', error);
  }
};
void initDb().then(() => initEnvironmentMonitor()).catch((error) => {
  console.error('Failed to initialize environment monitor:', error);
});

// Initialize MQTT Subscriber
initMqtt();


// Clean up old raw MQTT logs periodically (keep only last 1 month)
const cleanUpOldLogs = async () => {
  try {
    const result = await query("DELETE FROM raw_mqtt_logs WHERE received_at < NOW() - INTERVAL '1 month'");
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[Maintenance] Cleaned up ${result.rowCount} old MQTT logs (older than 1 month)`);
    }
  } catch (error) {
    console.error('[Maintenance] Failed to clean up old MQTT logs:', error);
  }
};

// Run cleanup once on startup
cleanUpOldLogs();
// Run cleanup every 24 hours
setInterval(cleanUpOldLogs, 24 * 60 * 60 * 1000);

const app: express.Application = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

/**
 * API Routes
 */
app.use('/api/auth', authRoutes)
app.use('/api/webhook', webhookRoutes)
app.use('/api/gateways', gatewaysRoutes)
app.use('/api/projects', projectsRoutes)
app.use('/api/tokens', apiTokensRoutes)
app.use('/api/shared', sharedRoutes)
app.use('/api/users', usersRoutes)
app.use('/api/distributions', distributionsRoutes)
app.use('/api/device-types', deviceTypesRoutes)
app.use('/api/points', pointsRoutes)
app.use('/api/meter', meterRoutes)
app.use('/api/electrical', electricalRoutes)
app.use('/api/environment-monitor', environmentMonitorRoutes)

/**
 * health
 */
app.use(
  '/api/health',
  (req: Request, res: Response, next: NextFunction): void => {
    res.status(200).json({
      success: true,
      message: 'ok',
    })
  },
)

/**
 * error handler middleware
 */
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({
    success: false,
    error: 'Server internal error',
  })
})

// Serve static files in production
const distPath = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req: Request, res: Response) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  console.warn('Production dist folder not found at:', distPath);
}

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API not found',
  })
})

export default app
