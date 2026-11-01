CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    parent_id INT REFERENCES projects(id) ON DELETE CASCADE,
    code VARCHAR(64) NOT NULL CONSTRAINT projects_code_not_blank CHECK (BTRIM(code) <> ''),
    name VARCHAR(128) NOT NULL,
    details TEXT,
    level INT NOT NULL CHECK (level >= 1 AND level <= 3),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_code_unique
ON projects (LOWER(BTRIM(code)));

CREATE TABLE IF NOT EXISTS gateway_info (
    sncode VARCHAR(64) PRIMARY KEY,
    project_id INT REFERENCES projects(id) ON DELETE SET NULL,
    alias VARCHAR(128),
    ip_address VARCHAR(64),
    mac_address VARCHAR(64),
    firmware_version VARCHAR(32),
    remote_enabled BOOLEAN DEFAULT FALSE,
    connection_password VARCHAR(128),
    publish_topic VARCHAR(255),
    subscribe_topic VARCHAR(255),
    status VARCHAR(16) DEFAULT 'OFFLINE',
    last_online_time TIMESTAMP,
    last_offline_time TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 网关与项目的多对多关系：一个任意层级主项目，可关联同一项目树内的其他项目。
CREATE TABLE IF NOT EXISTS gateway_project_bindings (
    gateway_sncode VARCHAR(64) REFERENCES gateway_info(sncode) ON DELETE CASCADE,
    project_id INT REFERENCES projects(id) ON DELETE CASCADE,
    binding_type VARCHAR(16) NOT NULL DEFAULT 'SHARED'
        CHECK (binding_type IN ('PRIMARY', 'SHARED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (gateway_sncode, project_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_project_one_primary
ON gateway_project_bindings (gateway_sncode)
WHERE binding_type = 'PRIMARY';
CREATE INDEX IF NOT EXISTS idx_gateway_project_project
ON gateway_project_bindings (project_id, gateway_sncode);

CREATE TABLE IF NOT EXISTS devices (
    id SERIAL PRIMARY KEY,
    gateway_sncode VARCHAR(64) REFERENCES gateway_info(sncode) ON DELETE CASCADE,
    device_code VARCHAR(64) NOT NULL,
    device_name VARCHAR(128),
    protocol_type VARCHAR(32),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(gateway_sncode, device_code)
);

CREATE TABLE IF NOT EXISTS data_points (
    id SERIAL PRIMARY KEY,
    device_id INT REFERENCES devices(id) ON DELETE CASCADE,
    point_name VARCHAR(64) NOT NULL,
    point_type VARCHAR(16) DEFAULT 'IO',
    upload_strategy VARCHAR(32),
    data_type VARCHAR(16),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alarm_rules (
    id SERIAL PRIMARY KEY,
    point_id INT REFERENCES data_points(id) ON DELETE CASCADE,
    is_enabled BOOLEAN DEFAULT FALSE,
    hh_limit NUMERIC,
    h_limit NUMERIC,
    l_limit NUMERIC,
    ll_limit NUMERIC,
    deadband NUMERIC DEFAULT 0,
    sustain_time INT DEFAULT 0,
    recovery_time INT DEFAULT 0,
    hh_msg VARCHAR(255),
    h_msg VARCHAR(255),
    l_msg VARCHAR(255),
    ll_msg VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id SERIAL PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    token VARCHAR(64) UNIQUE NOT NULL,
    project_ids INT[] NOT NULL DEFAULT '{}',
    permissions VARCHAR[] DEFAULT '{read_data}',
    status VARCHAR(32) DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(64) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(32) DEFAULT 'USER',
    project_ids INT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default admin if not exists (password: admin123)
INSERT INTO users (username, password, role) 
VALUES ('admin', '$2a$10$X8O9.W7.M2f6A2V.7l.l/uA/nQn1y4J/m8q8A3P7G4J4U5H9g5q.m', 'ADMIN') 
ON CONFLICT (username) DO NOTHING;

CREATE TABLE IF NOT EXISTS raw_mqtt_logs (
    topic VARCHAR(255),
    payload JSONB,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry_data(ts);
-- CREATE INDEX IF NOT EXISTS idx_telemetry_point ON telemetry_data(gateway_sncode, device_code, point_name);

CREATE TABLE IF NOT EXISTS data_distributions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    project_ids INT[] NOT NULL DEFAULT '{}',
    source_data_info TEXT,
    target_db_type VARCHAR(64),
    target_db_config JSONB,
    status VARCHAR(32) DEFAULT 'ACTIVE',
    start_time TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS device_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    code VARCHAR(64) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

-- 点位管理：按项目维护自定义点位名称
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
DROP INDEX IF EXISTS idx_project_points_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_points_unique_ins
ON project_points (project_id, COALESCE(insname,''));
