-- 001_init.sql —— 云栖盘初始表结构（幂等，可重复执行）
-- PostgreSQL 13+ 内置 gen_random_uuid()，无需 pgcrypto 扩展。
-- 注意：unique(user_id, parent_id, name) 对 NULL parent_id 不生效（NULL 互不相等），
-- 根目录下同名冲突由应用层事务内显式查重保证（parent_id IS NOT DISTINCT FROM $n）。

CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    quota_total bigint NOT NULL DEFAULT 10737418240,
    quota_used bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id uuid NULL,
    name text NOT NULL,
    is_dir boolean NOT NULL DEFAULT false,
    size bigint NOT NULL DEFAULT 0,
    mime text NOT NULL DEFAULT 'application/octet-stream',
    sha256 text NULL,
    encrypted boolean NOT NULL DEFAULT false,
    object_key text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT files_user_parent_name_key UNIQUE (user_id, parent_id, name)
);

CREATE INDEX IF NOT EXISTS idx_files_user_parent ON files (user_id, parent_id);

CREATE TABLE IF NOT EXISTS shares (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    token text UNIQUE NOT NULL,
    extract_code_hash text NULL,
    expires_at timestamptz NULL,
    max_downloads int NULL,
    downloads int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
