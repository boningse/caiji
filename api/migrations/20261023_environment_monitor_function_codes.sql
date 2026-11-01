-- 为环境监测记录保存设备属性中的规范功能码，并回填已有记录。
BEGIN;

ALTER TABLE environment_monitor_readings
  ADD COLUMN IF NOT EXISTS device_function_id INT REFERENCES device_type_functions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS function_code VARCHAR(64),
  ADD COLUMN IF NOT EXISTS function_name VARCHAR(128),
  ADD COLUMN IF NOT EXISTS data_type VARCHAR(32);

UPDATE environment_monitor_readings AS r
SET device_function_id = f.id,
    function_code = f.function_code,
    function_name = f.function_name,
    data_type = f.data_type,
    unit = COALESCE(NULLIF(f.unit, ''), r.unit)
FROM device_type_functions AS f
JOIN device_types AS t ON t.id = f.device_type_id
WHERE t.name = '环境监测设备'
  AND r.device_function_id IS NULL
  AND (
    LOWER(BTRIM(r.factor_name)) = LOWER(BTRIM(f.function_name))
    OR LOWER(BTRIM(r.factor_name)) = LOWER(BTRIM(SUBSTRING(f.description FROM '变量名\s*[:：]\s*([^|]+)')))
    OR (f.function_code = '6000019' AND LOWER(BTRIM(r.factor_name)) IN ('co2', '二氧化碳', '二氧化碳浓度'))
    OR (f.function_code = '6000020' AND LOWER(BTRIM(r.factor_name)) IN ('co', '一氧化碳', '一氧化碳浓度'))
    OR (f.function_code = '6000021' AND LOWER(BTRIM(r.factor_name)) = 'pm2.5')
    OR (f.function_code = '6000022' AND LOWER(BTRIM(r.factor_name)) = 'pm10')
    OR (f.function_code = '6000026' AND LOWER(BTRIM(r.factor_name)) = '甲醛')
    OR (f.function_code = '6002107' AND LOWER(BTRIM(r.factor_name)) = 'tvoc')
  );

CREATE INDEX IF NOT EXISTS idx_environment_readings_function_time
  ON environment_monitor_readings(project_id, function_code, sample_time DESC);

COMMIT;
