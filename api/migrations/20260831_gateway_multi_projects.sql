-- 网关多项目绑定：一个任意层级主项目，可附加同一项目树内的其他项目。
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

-- 兼容旧数据：没有主绑定时，保留 gateway_info 中原项目作为主项目。
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
DO UPDATE SET binding_type = 'PRIMARY';

-- 每个项目副本通过 project_id 区分，并为按项目、时间查询建立索引。
ALTER TABLE telemetry_data ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects(id);
ALTER TABLE telemetry_data ADD COLUMN IF NOT EXISTS point_id INT REFERENCES project_points(id);

CREATE INDEX IF NOT EXISTS idx_telemetry_data_project_time
ON telemetry_data (project_id, ts DESC);
