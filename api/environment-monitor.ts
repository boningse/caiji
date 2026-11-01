import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import mqtt, { type MqttClient } from 'mqtt';
import { query } from './db.js';

type EnvironmentConfig = {
  id: number;
  project_id: number;
  group_id: string;
  mqtt_broker: string;
  login_name: string;
  password_ciphertext: string;
  enabled: boolean;
};

type ManagedClient = { client: MqttClient; fingerprint: string; refreshTimer: ReturnType<typeof setInterval> };
type EnvironmentFunction = {
  id: number;
  function_code: string;
  function_name: string;
  data_type: string | null;
  unit: string | null;
  description: string | null;
};
const clients = new Map<number, ManagedClient>();
const MQTT_SUBSCRIPTION_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
let schemaPromise: Promise<void> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let environmentFunctions: Map<string, EnvironmentFunction> | null = null;
let environmentFunctionsLoadedAt = 0;

export const ensureEnvironmentMonitorSchema = () => {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS environment_monitor_configs (
          id SERIAL PRIMARY KEY,
          project_id INT NOT NULL,
          name VARCHAR(128) NOT NULL,
          api_base_url TEXT NOT NULL DEFAULT 'http://www.0531yun.com',
          mqtt_broker TEXT NOT NULL DEFAULT 'mqtt://rtd.mqtt.0531yun.com:1883',
          login_name VARCHAR(128) NOT NULL,
          password_ciphertext TEXT NOT NULL,
          group_id VARCHAR(128) NOT NULL,
          group_name VARCHAR(255) NOT NULL DEFAULT '',
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          connection_status VARCHAR(24) NOT NULL DEFAULT 'DISCONNECTED',
          last_error TEXT,
          last_received_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (project_id, group_id)
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS environment_monitor_readings (
          id BIGSERIAL,
          project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          config_id INT NOT NULL,
          group_id VARCHAR(128) NOT NULL,
          device_addr BIGINT NOT NULL,
          device_name TEXT NOT NULL DEFAULT '',
          system_code VARCHAR(64) NOT NULL DEFAULT '',
          device_status VARCHAR(32) NOT NULL DEFAULT '',
          latitude DOUBLE PRECISION,
          longitude DOUBLE PRECISION,
          relay_status JSONB,
          node_id INT NOT NULL,
          register_id INT NOT NULL,
          factor_id VARCHAR(255) NOT NULL DEFAULT '',
          factor_name VARCHAR(255) NOT NULL DEFAULT '',
          device_function_id INT REFERENCES device_type_functions(id) ON DELETE SET NULL,
          function_code VARCHAR(64),
          function_name VARCHAR(128),
          data_type VARCHAR(32),
          data_text TEXT NOT NULL DEFAULT '',
          value DOUBLE PRECISION,
          unit VARCHAR(64) NOT NULL DEFAULT '',
          alarm_level INT,
          alarm_color VARCHAR(32) NOT NULL DEFAULT '',
          alarm_info TEXT NOT NULL DEFAULT '',
          sample_time TIMESTAMPTZ NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id, sample_time),
          UNIQUE (project_id, group_id, device_addr, node_id, register_id, sample_time)
        )
      `);
      await query('ALTER TABLE environment_monitor_readings ADD COLUMN IF NOT EXISTS device_function_id INT REFERENCES device_type_functions(id) ON DELETE SET NULL');
      await query('ALTER TABLE environment_monitor_readings ADD COLUMN IF NOT EXISTS function_code VARCHAR(64)');
      await query('ALTER TABLE environment_monitor_readings ADD COLUMN IF NOT EXISTS function_name VARCHAR(128)');
      await query('ALTER TABLE environment_monitor_readings ADD COLUMN IF NOT EXISTS data_type VARCHAR(32)');
      await query(`SELECT create_hypertable(
        'environment_monitor_readings', 'sample_time',
        if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 day'
      )`);
      await query('CREATE INDEX IF NOT EXISTS idx_environment_readings_project_time ON environment_monitor_readings(project_id, sample_time DESC)');
      await query('CREATE INDEX IF NOT EXISTS idx_environment_readings_time ON environment_monitor_readings(sample_time DESC)');
      await query('CREATE INDEX IF NOT EXISTS idx_environment_readings_device_time ON environment_monitor_readings(device_addr, sample_time DESC)');
      await query('CREATE INDEX IF NOT EXISTS idx_environment_readings_factor_time ON environment_monitor_readings(project_id, factor_name, sample_time DESC)');
      await query('CREATE INDEX IF NOT EXISTS idx_environment_readings_function_time ON environment_monitor_readings(project_id, function_code, sample_time DESC)');
      await query('CREATE INDEX IF NOT EXISTS idx_environment_configs_enabled ON environment_monitor_configs(enabled, id)');
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
};

const encryptionKey = () => {
  const secret = process.env.ENVIRONMENT_MONITOR_ENCRYPTION_KEY;
  if (!secret || secret.trim().length < 32) {
    throw new Error('ENVIRONMENT_MONITOR_ENCRYPTION_KEY must contain at least 32 characters');
  }
  return createHash('sha256').update(secret).digest();
};

export const encryptEnvironmentSecret = (plainText: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`;
};

export const decryptEnvironmentSecret = (encoded: string) => {
  const [version, ivHex, tagHex, dataHex] = encoded.split('.');
  if (version !== 'v1' || !ivHex || !tagHex || !dataHex) throw new Error('Invalid encrypted environment credential');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
};

const optionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const payloadDate = (value: unknown) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return new Date();
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const parseRelayStatus = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
};

const normalizeFunctionAlias = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

const getEnvironmentFunctionMap = async () => {
  if (environmentFunctions && Date.now() - environmentFunctionsLoadedAt < 60_000) return environmentFunctions;

  const result = await query(`
    SELECT dtf.id, dtf.function_code, dtf.function_name, dtf.data_type, dtf.unit, dtf.description
    FROM device_type_functions dtf
    JOIN device_types dt ON dt.id = dtf.device_type_id
    WHERE dt.name = '环境监测设备'
  `);
  const functions = new Map<string, EnvironmentFunction>();
  const protocolAliases: Record<string, string[]> = {
    '6000019': ['CO2', '二氧化碳', '二氧化碳浓度'],
    '6000020': ['CO', '一氧化碳', '一氧化碳浓度'],
    '6000021': ['PM2.5'],
    '6000022': ['PM10'],
    '6000026': ['甲醛'],
    '6002107': ['TVOC']
  };
  for (const row of result.rows as EnvironmentFunction[]) {
    const aliases = [row.function_code, row.function_name, row.function_name.replace(/(?:浓度|含量|测量值)$/u, '')];
    const variableName = row.description?.match(/(?:变量名|变量名称)\s*[:：]\s*([^|]+)/)?.[1];
    if (variableName) aliases.push(variableName);
    aliases.push(...(protocolAliases[row.function_code] || []));
    for (const alias of aliases) {
      const key = normalizeFunctionAlias(alias);
      if (key) functions.set(key, row);
    }
  }
  environmentFunctions = functions;
  environmentFunctionsLoadedAt = Date.now();
  return functions;
};

const matchEnvironmentFunction = (factor: any, functions: Map<string, EnvironmentFunction>) => {
  const aliases = [
    factor?.functionCode, factor?.function_code, factor?.registerCode, factor?.registerId,
    factor?.registerName, factor?.variableName, factor?.name
  ];
  for (const alias of aliases) {
    const match = functions.get(normalizeFunctionAlias(alias));
    if (match) return match;
  }
  return null;
};

const insertEnvironmentPayload = async (config: EnvironmentConfig, message: Buffer) => {
  let payload: any;
  try { payload = JSON.parse(message.toString('utf8')); } catch { return; }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.dataItem)) return;

  const deviceAddr = String(payload.deviceAddr ?? '').trim();
  if (!/^\d{1,18}$/.test(deviceAddr)) return;
  const sampleTime = payloadDate(payload.timeStamp);
  const functionMap = await getEnvironmentFunctionMap();
  const rows: any[][] = [];

  for (const node of payload.dataItem) {
    const nodeId = optionalNumber(node?.nodeId);
    if (nodeId === null || !Array.isArray(node?.registerItem)) continue;
    for (const factor of node.registerItem) {
      const registerId = optionalNumber(factor?.registerId);
      if (registerId === null) continue;
      const rawValue = factor?.value;
      const numericValue = optionalNumber(rawValue) ?? optionalNumber(factor?.data);
      const textValue = factor?.data === null || factor?.data === undefined
        ? (rawValue === null || rawValue === undefined ? '' : String(rawValue))
        : String(factor.data);
      const mappedFunction = matchEnvironmentFunction(factor, functionMap);
      rows.push([
        config.project_id, config.id, config.group_id, deviceAddr,
        String(payload.deviceName ?? ''), String(payload.systemCode ?? ''), String(payload.deviceStatus ?? ''),
        optionalNumber(payload.lat), optionalNumber(payload.lng), parseRelayStatus(payload.relayStatus),
        nodeId, registerId, `${deviceAddr}_${nodeId}_${registerId}`,
        String(factor.registerName ?? ''), mappedFunction?.id ?? null,
        mappedFunction?.function_code ?? null, mappedFunction?.function_name ?? null,
        mappedFunction?.data_type ?? null, textValue, numericValue,
        mappedFunction?.unit || String(factor.unit ?? ''), optionalNumber(factor.alarmLevel),
        String(factor.alarmColor ?? ''), String(factor.alarmInfo ?? ''), sampleTime
      ]);
    }
  }
  if (rows.length === 0) return;

  const parameters: any[] = [];
  const values = rows.map((row) => {
    const offset = parameters.length;
    parameters.push(...row);
    return `(${row.map((_, index) => `$${offset + index + 1}`).join(',')})`;
  });
  const result = await query(`
    INSERT INTO environment_monitor_readings (
      project_id, config_id, group_id, device_addr, device_name, system_code, device_status,
      latitude, longitude, relay_status, node_id, register_id, factor_id, factor_name,
      device_function_id, function_code, function_name, data_type, data_text, value, unit,
      alarm_level, alarm_color, alarm_info, sample_time
    ) VALUES ${values.join(',')}
    ON CONFLICT (project_id, group_id, device_addr, node_id, register_id, sample_time) DO NOTHING
  `, parameters);
  if (result.rowCount && result.rowCount > 0) {
    await query(`UPDATE environment_monitor_configs
      SET last_received_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`, [config.id]);
  }
};

const fingerprint = (config: EnvironmentConfig) => [
  config.mqtt_broker, config.login_name, config.password_ciphertext, config.group_id
].join('\u0000');

const stopClient = async (id: number) => {
  const managed = clients.get(id);
  if (!managed) return;
  clients.delete(id);
  clearInterval(managed.refreshTimer);
  managed.client.removeAllListeners('message');
  await new Promise<void>((resolve) => managed.client.end(true, {}, () => resolve()));
};

const startClient = async (config: EnvironmentConfig) => {
  const password = decryptEnvironmentSecret(config.password_ciphertext);
  const client = mqtt.connect(config.mqtt_broker, {
    username: config.login_name,
    password,
    clientId: `environment-${config.id}-${randomBytes(4).toString('hex')}`,
    clean: true,
    keepalive: 60,
    reconnectPeriod: 5000,
    connectTimeout: 15000
  });
  const currentFingerprint = fingerprint(config);
  const refreshTimer = setInterval(() => {
    // Some upstream platforms refresh the devices authorized for a group only
    // when its MQTT session subscribes again. Periodically reconnect so newly
    // added devices begin flowing without deleting and recreating this config.
    if (client.connected && !client.reconnecting && !client.disconnecting) {
      client.reconnect();
    }
  }, MQTT_SUBSCRIPTION_REFRESH_INTERVAL_MS);
  clients.set(config.id, { client, fingerprint: currentFingerprint, refreshTimer });
  await query(`UPDATE environment_monitor_configs SET connection_status = 'CONNECTING', last_error = NULL WHERE id = $1`, [config.id]);

  client.on('connect', () => {
    client.subscribe(`rtd/${config.group_id}`, { qos: 0 }, (error) => {
      if (error) {
        void query(`UPDATE environment_monitor_configs SET connection_status = 'ERROR', last_error = 'MQTT 主题订阅失败' WHERE id = $1`, [config.id]);
        return;
      }
      void query(`UPDATE environment_monitor_configs SET connection_status = 'CONNECTED', last_error = NULL WHERE id = $1`, [config.id]);
    });
  });
  client.on('message', (topic, message) => {
    if (topic !== `rtd/${config.group_id}`) return;
    void insertEnvironmentPayload(config, message).catch(() => {
      void query(`UPDATE environment_monitor_configs SET last_error = '数据解析或入库失败' WHERE id = $1`, [config.id]);
    });
  });
  client.on('reconnect', () => {
    void query(`UPDATE environment_monitor_configs SET connection_status = 'CONNECTING' WHERE id = $1`, [config.id]);
  });
  client.on('offline', () => {
    void query(`UPDATE environment_monitor_configs SET connection_status = 'DISCONNECTED' WHERE id = $1`, [config.id]);
  });
  client.on('error', () => {
    void query(`UPDATE environment_monitor_configs SET connection_status = 'ERROR', last_error = 'MQTT 连接失败，请检查服务器地址和账户配置' WHERE id = $1`, [config.id]);
  });
};

export const syncEnvironmentMonitorClients = async () => {
  await ensureEnvironmentMonitorSchema();
  const result = await query(`SELECT id, project_id, group_id, mqtt_broker, login_name, password_ciphertext, enabled
    FROM environment_monitor_configs WHERE enabled = TRUE`);
  const active = new Map<number, EnvironmentConfig>(result.rows.map((row: EnvironmentConfig) => [Number(row.id), row]));

  for (const [id, managed] of clients) {
    const config = active.get(id);
    if (!config || managed.fingerprint !== fingerprint(config)) await stopClient(id);
  }
  for (const config of active.values()) {
    if (clients.has(config.id)) continue;
    try {
      await startClient(config);
    } catch {
      await query(`UPDATE environment_monitor_configs SET connection_status = 'ERROR', last_error = '环境监测连接启动失败，请检查加密密钥和配置' WHERE id = $1`, [config.id]);
    }
  }
};

export const initEnvironmentMonitor = async () => {
  await ensureEnvironmentMonitorSchema();
  await syncEnvironmentMonitorClients();
  if (!syncTimer) {
    syncTimer = setInterval(() => {
      syncEnvironmentMonitorClients().catch(() => console.error('Environment monitor client synchronization failed'));
    }, 30_000);
  }
};
