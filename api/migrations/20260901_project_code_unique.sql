-- 项目编号必填，并在忽略大小写和首尾空格后保持全局唯一。
UPDATE projects
SET code = BTRIM(code)
WHERE code IS DISTINCT FROM BTRIM(code);

ALTER TABLE projects
ALTER COLUMN code SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_code_not_blank'
  ) THEN
    ALTER TABLE projects
    ADD CONSTRAINT projects_code_not_blank CHECK (BTRIM(code) <> '');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_code_unique
ON projects (LOWER(BTRIM(code)));
