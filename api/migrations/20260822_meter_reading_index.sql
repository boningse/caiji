-- 支持按电表设备编码和属性编号快速获取最新累计电量。
-- telemetry_data 是 TimescaleDB hypertable，按 chunk 建索引可避免长时间阻塞写入。
CREATE INDEX IF NOT EXISTS idx_telemetry_meter_reading
ON telemetry_data (device_code, propertyno, ts DESC)
WITH (timescaledb.transaction_per_chunk);
