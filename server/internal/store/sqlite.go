// sqlite.go —— 单机模式元数据实现（LOCAL_MODE=1）：
// 用 modernc.org/sqlite（纯 Go、无 cgo）存储 users/files/shares 三表，
// 数据文件位于 DATA_DIR/cloudpan.db；启动时幂等建表，零外部依赖。
//
// 与 PgStore 的差异处理：
//   - 占位符 $n → ?；无 ::uuid/::text 显式转换（id 一律 TEXT）；
//   - 主键 uuid 由应用层生成（google/uuid）并在 INSERT 时显式传入；
//   - 时间以 RFC3339Nano 文本存储（liteTime 类型实现 driver.Valuer / sql.Scanner）；
//   - 约束冲突通过错误文本识别（UNIQUE / FOREIGN KEY constraint failed）；
//   - RowsAffected 语义与 PG 一致（0 表示未命中）。
package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite" // 纯 Go SQLite 驱动
)

// liteTime 将 time.Time 以 RFC3339Nano 文本存取（SQLite 无原生时间类型，
// 且 modernc 驱动不会自动把 TEXT 解析为 time.Time，故用自定义类型）。
type liteTime time.Time

func (t liteTime) Value() (driver.Value, error) {
	return time.Time(t).UTC().Format(time.RFC3339Nano), nil
}

func (t *liteTime) Scan(v any) error {
	switch s := v.(type) {
	case nil:
		return nil
	case time.Time:
		*t = liteTime(s)
		return nil
	case string:
		if s == "" {
			return nil
		}
		tt, err := time.Parse(time.RFC3339Nano, s)
		if err == nil {
			*t = liteTime(tt)
			return nil
		}
		tt, err = time.Parse(time.RFC3339, s)
		if err == nil {
			*t = liteTime(tt)
			return nil
		}
		return fmt.Errorf("无法解析时间文本: %q", s)
	case []byte:
		return t.Scan(string(s))
	default:
		return fmt.Errorf("无法解析时间值: %T", v)
	}
}

func lt(t time.Time) liteTime { return liteTime(t) }
func tt(t liteTime) time.Time { return time.Time(t) }

// SqliteStore 单机模式元数据实现。
type SqliteStore struct {
	db *sql.DB
}

// NewSqlite 打开（不存在则创建）SQLite 数据库并幂等建表。
func NewSqlite(dbPath string) (*SqliteStore, error) {
	// SQLite 不会自动创建父目录，先确保目录存在
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}
	dsn := "file:" + strings.ReplaceAll(dbPath, "\\", "/") +
		"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开 SQLite 失败: %w", err)
	}
	// SQLite 单写者：限制为 1 个连接，避免并发写锁冲突
	db.SetMaxOpenConns(1)
	s := &SqliteStore{db: db}
	if err := s.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// migrate 幂等建表（与 migrations/001_init.sql 字段对齐）。
func (s *SqliteStore) migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			quota_total INTEGER NOT NULL DEFAULT 10737418240,
			quota_used INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS files (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			parent_id TEXT NULL,
			name TEXT NOT NULL,
			is_dir INTEGER NOT NULL DEFAULT 0,
			size INTEGER NOT NULL DEFAULT 0,
			mime TEXT NOT NULL DEFAULT 'application/octet-stream',
			sha256 TEXT NULL,
			encrypted INTEGER NOT NULL DEFAULT 0,
			object_key TEXT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_files_user_parent ON files (user_id, parent_id)`,
		`CREATE TABLE IF NOT EXISTS shares (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			file_id TEXT NOT NULL,
			token TEXT UNIQUE NOT NULL,
			extract_code_hash TEXT NULL,
			expires_at TEXT NULL,
			max_downloads INTEGER NULL,
			downloads INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("SQLite 建表失败: %w", err)
		}
	}
	return nil
}

// Ping 健康检查用。
func (s *SqliteStore) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// Close 关闭数据库。
func (s *SqliteStore) Close() { _ = s.db.Close() }

// isUniqueViolationLite 识别 SQLite 唯一约束冲突。
func isUniqueViolationLite(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// isFKViolationLite 识别 SQLite 外键冲突。
func isFKViolationLite(err error) bool {
	return err != nil && strings.Contains(err.Error(), "FOREIGN KEY constraint failed")
}

func noRows(err error) bool { return errors.Is(err, sql.ErrNoRows) }

// sqliteFileCols 统一的 files 列顺序（与 scanFileLite 对应）。
var sqliteFileCols = `id, user_id, parent_id, name, is_dir, size, mime, sha256, encrypted, object_key, created_at, updated_at`

// scanFileLiteRow 从 *sql.Row 扫描一行 files。
func scanFileLiteRow(row *sql.Row) (File, error) {
	var f File
	var ca, ua liteTime
	err := row.Scan(&f.ID, &f.UserID, &f.ParentID, &f.Name, &f.IsDir, &f.Size, &f.Mime, &f.SHA256, &f.Encrypted, &f.ObjectKey, &ca, &ua)
	if err != nil {
		return File{}, err
	}
	f.CreatedAt = tt(ca)
	f.UpdatedAt = tt(ua)
	return f, nil
}

// scanFileLiteRows 从 *sql.Rows 扫描一行 files。
func scanFileLiteRows(rows *sql.Rows) (File, error) {
	var f File
	var ca, ua liteTime
	err := rows.Scan(&f.ID, &f.UserID, &f.ParentID, &f.Name, &f.IsDir, &f.Size, &f.Mime, &f.SHA256, &f.Encrypted, &f.ObjectKey, &ca, &ua)
	if err != nil {
		return File{}, err
	}
	f.CreatedAt = tt(ca)
	f.UpdatedAt = tt(ua)
	return f, nil
}

// scanUserLite 从 *sql.Row 扫描一行 users。
func scanUserLite(row *sql.Row) (User, error) {
	var u User
	var ca liteTime
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.QuotaTotal, &u.QuotaUsed, &ca)
	if err != nil {
		return User{}, err
	}
	u.CreatedAt = tt(ca)
	return u, nil
}

// childExistsLite 同层同名查重。
func childExistsLite(ctx context.Context, q queryerLite, userID string, parentID *string, name, excludeID string) (bool, error) {
	sqlText := `SELECT EXISTS(
		SELECT 1 FROM files
		WHERE user_id = ? AND parent_id IS NOT DISTINCT FROM ? AND name = ?`
	var exists bool
	var err error
	if excludeID != "" {
		sqlText += ` AND id <> ?)`
		err = q.QueryRowContext(ctx, sqlText, userID, parentID, name, excludeID).Scan(&exists)
	} else {
		sqlText += `)`
		err = q.QueryRowContext(ctx, sqlText, userID, parentID, name).Scan(&exists)
	}
	if err != nil {
		return false, err
	}
	return exists, nil
}

// depthOfLite 计算节点到根目录的层数。
func depthOfLite(ctx context.Context, q queryerLite, userID, id string) (int, error) {
	var depth int
	err := q.QueryRowContext(ctx, `
		WITH RECURSIVE ancestors AS (
			SELECT id, parent_id, 1 AS depth FROM files WHERE id = ? AND user_id = ?
			UNION ALL
			SELECT f.id, f.parent_id, a.depth + 1 FROM files f JOIN ancestors a ON f.id = a.parent_id
		)
		SELECT COALESCE(MAX(depth), 0) FROM ancestors`, id, userID).Scan(&depth)
	if err != nil {
		return 0, err
	}
	return depth, nil
}

// queryerLite database/sql 的 *sql.DB / *sql.Tx 共同查询接口。
type queryerLite interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// CreateUser 注册用户（应用层生成 UUID）。
func (s *SqliteStore) CreateUser(ctx context.Context, username, passwordHash string, quotaTotal int64) (User, error) {
	u := User{
		ID:           uuid.NewString(),
		Username:     username,
		PasswordHash: passwordHash,
		QuotaTotal:   quotaTotal,
		QuotaUsed:    0,
		CreatedAt:    time.Now().UTC(),
	}
	now := lt(time.Now().UTC())
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO users (id, username, password_hash, quota_total, quota_used, created_at, updated_at)
		VALUES (?, ?, ?, ?, 0, ?, ?)`,
		u.ID, username, passwordHash, quotaTotal, now, now)
	if err != nil {
		if isUniqueViolationLite(err) {
			return User{}, ErrConflict
		}
		return User{}, fmt.Errorf("创建用户失败: %w", err)
	}
	return u, nil
}

// GetUserByUsername 按用户名查询。
func (s *SqliteStore) GetUserByUsername(ctx context.Context, username string) (User, error) {
	u, err := scanUserLite(s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, quota_total, quota_used, created_at FROM users WHERE username = ?`,
		username))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("按用户名查询用户失败: %w", err)
	}
	return u, nil
}

// GetUserByID 按 ID 查询用户。
func (s *SqliteStore) GetUserByID(ctx context.Context, id string) (User, error) {
	u, err := scanUserLite(s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, quota_total, quota_used, created_at FROM users WHERE id = ?`,
		id))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("按 ID 查询用户失败: %w", err)
	}
	return u, nil
}

// ListChildren 列出目录子项（目录在前、名称升序）。
func (s *SqliteStore) ListChildren(ctx context.Context, userID string, parentID *string) ([]File, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+sqliteFileCols+" FROM files WHERE user_id = ? AND parent_id IS NOT DISTINCT FROM ? ORDER BY is_dir DESC, name ASC",
		userID, parentID)
	if err != nil {
		return nil, fmt.Errorf("查询目录内容失败: %w", err)
	}
	defer rows.Close()
	files := make([]File, 0)
	for rows.Next() {
		f, err := scanFileLiteRows(rows)
		if err != nil {
			return nil, fmt.Errorf("扫描文件行失败: %w", err)
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

// ListAll 返回用户全部文件/目录（扁平数组）。
func (s *SqliteStore) ListAll(ctx context.Context, userID string) ([]File, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+sqliteFileCols+" FROM files WHERE user_id = ? ORDER BY parent_id IS NULL DESC, is_dir DESC, name ASC LIMIT 20001",
		userID)
	if err != nil {
		return nil, fmt.Errorf("查询文件树失败: %w", err)
	}
	defer rows.Close()
	files := make([]File, 0, 256)
	for rows.Next() {
		f, err := scanFileLiteRows(rows)
		if err != nil {
			return nil, fmt.Errorf("扫描文件行失败: %w", err)
		}
		files = append(files, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历文件树失败: %w", err)
	}
	if len(files) > 20000 {
		return nil, ErrTooManyNodes
	}
	return files, nil
}

// GetFileByID 按 ID 查询。
func (s *SqliteStore) GetFileByID(ctx context.Context, id string) (File, error) {
	f, err := scanFileLiteRow(s.db.QueryRowContext(ctx, "SELECT "+sqliteFileCols+" FROM files WHERE id = ?", id))
	if noRows(err) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, fmt.Errorf("按 ID 查询文件失败: %w", err)
	}
	return f, nil
}

// CreateDir 创建目录（事务：归属/类型/深度/查重校验）。
func (s *SqliteStore) CreateDir(ctx context.Context, userID string, parentID *string, name string) (File, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return File{}, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if parentID != nil {
		var isDir bool
		err := tx.QueryRowContext(ctx, `SELECT is_dir FROM files WHERE id = ? AND user_id = ?`, *parentID, userID).Scan(&isDir)
		if noRows(err) {
			return File{}, ErrParentNotFound
		}
		if err != nil {
			return File{}, fmt.Errorf("查询父目录失败: %w", err)
		}
		if !isDir {
			return File{}, ErrParentNotFound
		}
		depth, err := depthOfLite(ctx, tx, userID, *parentID)
		if err != nil {
			return File{}, fmt.Errorf("计算目录深度失败: %w", err)
		}
		if depth >= maxTreeDepth {
			return File{}, ErrDepthExceeded
		}
	}

	exists, err := childExistsLite(ctx, tx, userID, parentID, name, "")
	if err != nil {
		return File{}, fmt.Errorf("目录查重失败: %w", err)
	}
	if exists {
		return File{}, ErrConflict
	}

	nowT := time.Now().UTC()
	now := lt(nowT)
	f := File{
		ID:        uuid.NewString(),
		UserID:    userID,
		ParentID:  parentID,
		Name:      name,
		IsDir:     true,
		Mime:      "inode/directory",
		CreatedAt: nowT,
		UpdatedAt: nowT,
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO files (id, user_id, parent_id, name, is_dir, size, mime, created_at, updated_at)
		VALUES (?, ?, ?, ?, 1, 0, 'inode/directory', ?, ?)`,
		f.ID, userID, parentID, name, now, now)
	if err != nil {
		if isUniqueViolationLite(err) {
			return File{}, ErrConflict
		}
		return File{}, fmt.Errorf("创建目录失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return File{}, fmt.Errorf("提交事务失败: %w", err)
	}
	return f, nil
}

// RenameFile 重命名（事务：归属校验 + 查重后更新）。
func (s *SqliteStore) RenameFile(ctx context.Context, userID, id, name string) (File, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return File{}, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	target, err := scanFileLiteRow(tx.QueryRowContext(ctx, "SELECT "+sqliteFileCols+" FROM files WHERE id = ?", id))
	if noRows(err) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, fmt.Errorf("查询目标失败: %w", err)
	}
	if target.UserID != userID {
		return File{}, ErrForbidden
	}

	exists, err := childExistsLite(ctx, tx, userID, target.ParentID, name, id)
	if err != nil {
		return File{}, fmt.Errorf("重命名查重失败: %w", err)
	}
	if exists {
		return File{}, ErrConflict
	}

	if _, err := tx.ExecContext(ctx, `UPDATE files SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?`, name, lt(time.Now().UTC()), id, userID); err != nil {
		return File{}, fmt.Errorf("重命名失败: %w", err)
	}
	target.Name = name
	target.UpdatedAt = time.Now().UTC()
	if err := tx.Commit(); err != nil {
		return File{}, fmt.Errorf("提交事务失败: %w", err)
	}
	return target, nil
}

// MoveFile 移动（事务：归属/新父目录/防环/深度/查重校验）。
func (s *SqliteStore) MoveFile(ctx context.Context, userID, id string, parentID *string) (File, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return File{}, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	target, err := scanFileLiteRow(tx.QueryRowContext(ctx, "SELECT "+sqliteFileCols+" FROM files WHERE id = ?", id))
	if noRows(err) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, fmt.Errorf("查询目标失败: %w", err)
	}
	if target.UserID != userID {
		return File{}, ErrForbidden
	}

	if parentID != nil {
		var isDir bool
		err := tx.QueryRowContext(ctx, `SELECT is_dir FROM files WHERE id = ? AND user_id = ?`, *parentID, userID).Scan(&isDir)
		if noRows(err) {
			return File{}, ErrParentNotFound
		}
		if err != nil {
			return File{}, fmt.Errorf("查询目标目录失败: %w", err)
		}
		if !isDir {
			return File{}, ErrParentNotFound
		}
		if target.IsDir {
			var cycle bool
			err := tx.QueryRowContext(ctx, `
				WITH RECURSIVE sub AS (
					SELECT id FROM files WHERE id = ?
					UNION ALL
					SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
				)
				SELECT EXISTS(SELECT 1 FROM sub WHERE id = ?)`, id, *parentID).Scan(&cycle)
			if err != nil {
				return File{}, fmt.Errorf("防环校验失败: %w", err)
			}
			if cycle {
				return File{}, ErrCycle
			}
		}
		depth, err := depthOfLite(ctx, tx, userID, *parentID)
		if err != nil {
			return File{}, fmt.Errorf("计算目录深度失败: %w", err)
		}
		if depth >= maxTreeDepth {
			return File{}, ErrDepthExceeded
		}
	}

	exists, err := childExistsLite(ctx, tx, userID, parentID, target.Name, id)
	if err != nil {
		return File{}, fmt.Errorf("移动查重失败: %w", err)
	}
	if exists {
		return File{}, ErrConflict
	}

	if _, err := tx.ExecContext(ctx, `UPDATE files SET parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`, parentID, lt(time.Now().UTC()), id, userID); err != nil {
		return File{}, fmt.Errorf("移动失败: %w", err)
	}
	target.ParentID = parentID
	target.UpdatedAt = time.Now().UTC()
	if err := tx.Commit(); err != nil {
		return File{}, fmt.Errorf("提交事务失败: %w", err)
	}
	return target, nil
}

// DeleteFile 删除文件或目录（recursive=true 时递归删除整棵子树），返回释放配额与对象键。
func (s *SqliteStore) DeleteFile(ctx context.Context, userID, id string, recursive bool) (freed int64, keys []string, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	root, err := scanFileLiteRow(tx.QueryRowContext(ctx, "SELECT "+sqliteFileCols+" FROM files WHERE id = ?", id))
	if noRows(err) {
		return 0, nil, ErrNotFound
	}
	if err != nil {
		return 0, nil, fmt.Errorf("查询目标失败: %w", err)
	}
	if root.UserID != userID {
		return 0, nil, ErrForbidden
	}
	if root.IsDir && !recursive {
		return 0, nil, ErrInvalidInput
	}

	rows, err := tx.QueryContext(ctx, `
		WITH RECURSIVE sub AS (
			SELECT id, is_dir, size, object_key FROM files WHERE id = ?
			UNION ALL
			SELECT f.id, f.is_dir, f.size, f.object_key FROM files f JOIN sub s ON f.parent_id = s.id
		)
		SELECT object_key, is_dir, size FROM sub`, id)
	if err != nil {
		return 0, nil, fmt.Errorf("收集子树失败: %w", err)
	}
	var total int64
	keys = make([]string, 0)
	for rows.Next() {
		var key *string
		var isDir bool
		var size int64
		if err := rows.Scan(&key, &isDir, &size); err != nil {
			rows.Close()
			return 0, nil, fmt.Errorf("扫描子树失败: %w", err)
		}
		total += size
		if key != nil && !isDir {
			keys = append(keys, *key)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, nil, fmt.Errorf("遍历子树失败: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		WITH RECURSIVE sub AS (
			SELECT id FROM files WHERE id = ?
			UNION ALL
			SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
		)
		DELETE FROM files WHERE id IN (SELECT id FROM sub)`, id); err != nil {
		return 0, nil, fmt.Errorf("删除文件行失败: %w", err)
	}

	if total > 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE users SET quota_used = MAX(quota_used - ?, 0), updated_at = ?
			WHERE id = ?`, total, lt(time.Now().UTC()), userID); err != nil {
			return 0, nil, fmt.Errorf("扣减配额失败: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, nil, fmt.Errorf("提交事务失败: %w", err)
	}
	return total, keys, nil
}

// CreateFileComplete 分块上传完成后入库（事务：查重 → 父目录 → INSERT → 配额守卫更新）。
func (s *SqliteStore) CreateFileComplete(ctx context.Context, userID, id string, parentID *string, name string, size int64, mimeType string, sha256 *string, encrypted bool, objectKey string) (File, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return File{}, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	exists, err := childExistsLite(ctx, tx, userID, parentID, name, "")
	if err != nil {
		return File{}, fmt.Errorf("查重失败: %w", err)
	}
	if exists {
		return File{}, ErrConflict
	}
	if parentID != nil {
		var isDir bool
		err := tx.QueryRowContext(ctx, `SELECT is_dir FROM files WHERE id = ? AND user_id = ?`, *parentID, userID).Scan(&isDir)
		if noRows(err) {
			return File{}, ErrParentNotFound
		}
		if err != nil {
			return File{}, fmt.Errorf("查询父目录失败: %w", err)
		}
		if !isDir {
			return File{}, ErrParentNotFound
		}
	}

	now := time.Now().UTC()
	f := File{
		ID:        id,
		UserID:    userID,
		ParentID:  parentID,
		Name:      name,
		Size:      size,
		Mime:      mimeType,
		SHA256:    sha256,
		Encrypted: encrypted,
		ObjectKey: &objectKey,
		CreatedAt: now,
		UpdatedAt: now,
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO files (id, user_id, parent_id, name, is_dir, size, mime, sha256, encrypted, object_key, created_at, updated_at)
		VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID, userID, parentID, name, size, mimeType, sha256, encrypted, objectKey, lt(now), lt(now))
	if err != nil {
		if isUniqueViolationLite(err) {
			return File{}, ErrConflict
		}
		return File{}, fmt.Errorf("插入文件行失败: %w", err)
	}

	// 配额终检（守卫 UPDATE，0 行 = 配额不足）
	res, err := tx.ExecContext(ctx, `
		UPDATE users SET quota_used = quota_used + ?, updated_at = ?
		WHERE id = ? AND (quota_total = 0 OR quota_used + ? <= quota_total)`, size, lt(time.Now().UTC()), userID, size)
	if err != nil {
		return File{}, fmt.Errorf("更新配额失败: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var total, used int64
		err := tx.QueryRowContext(ctx, `SELECT quota_total, quota_used FROM users WHERE id = ?`, userID).Scan(&total, &used)
		if noRows(err) {
			return File{}, ErrNotFound
		}
		if err != nil {
			return File{}, fmt.Errorf("查询配额失败: %w", err)
		}
		return File{}, ErrQuotaExceeded
	}

	if err := tx.Commit(); err != nil {
		return File{}, fmt.Errorf("提交事务失败: %w", err)
	}
	return f, nil
}

// CreateShare 创建分享（应用层生成 UUID）。
func (s *SqliteStore) CreateShare(ctx context.Context, userID, fileID, token string, codeHash *string, expiresAt *time.Time, maxDownloads *int) (Share, error) {
	sh := Share{
		ID:              uuid.NewString(),
		UserID:          userID,
		FileID:          fileID,
		Token:           token,
		ExtractCodeHash: codeHash,
		RequireCode:     codeHash != nil,
		ExpiresAt:       expiresAt,
		MaxDownloads:    maxDownloads,
		CreatedAt:       time.Now().UTC(),
	}
	var expLite *liteTime
	if expiresAt != nil {
		e := lt(*expiresAt)
		expLite = &e
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO shares (id, user_id, file_id, token, extract_code_hash, expires_at, max_downloads, downloads, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
		sh.ID, userID, fileID, token, codeHash, expLite, maxDownloads, lt(sh.CreatedAt))
	if err != nil {
		if isUniqueViolationLite(err) {
			return Share{}, ErrConflict
		}
		if isFKViolationLite(err) {
			return Share{}, ErrNotFound
		}
		return Share{}, fmt.Errorf("创建分享失败: %w", err)
	}
	var name string
	if err := s.db.QueryRowContext(ctx, `SELECT name FROM files WHERE id = ?`, fileID).Scan(&name); err != nil {
		return Share{}, fmt.Errorf("查询分享文件名失败: %w", err)
	}
	sh.FileName = name
	return sh, nil
}

const sqliteShareCols = `s.id, s.user_id, s.file_id, s.token, s.extract_code_hash, s.expires_at, s.max_downloads, s.downloads, s.created_at`

// ListShares 当前用户的分享列表（含 file_name）。
func (s *SqliteStore) ListShares(ctx context.Context, userID string) ([]Share, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+sqliteShareCols+`, f.name, f.is_dir, f.size
		FROM shares s JOIN files f ON f.id = s.file_id
		WHERE s.user_id = ?
		ORDER BY s.created_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("查询分享列表失败: %w", err)
	}
	defer rows.Close()
	shares := make([]Share, 0)
	for rows.Next() {
		var sh Share
		var exp *liteTime
		var ca liteTime
		if err := rows.Scan(&sh.ID, &sh.UserID, &sh.FileID, &sh.Token, &sh.ExtractCodeHash, &exp, &sh.MaxDownloads, &sh.Downloads, &ca, &sh.FileName, &sh.IsDir, &sh.Size); err != nil {
			return nil, fmt.Errorf("扫描分享行失败: %w", err)
		}
		if exp != nil {
			t := tt(*exp)
			sh.ExpiresAt = &t
		}
		sh.CreatedAt = tt(ca)
		sh.RequireCode = sh.ExtractCodeHash != nil
		shares = append(shares, sh)
	}
	return shares, rows.Err()
}

// GetShareByToken 按 token 查询分享（含根文件 name/is_dir/size）。
// 注意：modernc 驱动要求 Scan 目标数必须与 SELECT 列数一致（与 pgx 不同），
// 因此联查字段必须在同一次 Scan 中接收。
func (s *SqliteStore) GetShareByToken(ctx context.Context, token string) (Share, error) {
	var sh Share
	var exp *liteTime
	var ca liteTime
	err := s.db.QueryRowContext(ctx, `
		SELECT `+sqliteShareCols+`, f.name, f.is_dir, f.size
		FROM shares s JOIN files f ON f.id = s.file_id
		WHERE s.token = ?`, token).Scan(
		&sh.ID, &sh.UserID, &sh.FileID, &sh.Token, &sh.ExtractCodeHash, &exp, &sh.MaxDownloads, &sh.Downloads, &ca,
		&sh.FileName, &sh.IsDir, &sh.Size)
	if noRows(err) {
		return Share{}, ErrNotFound
	}
	if err != nil {
		return Share{}, fmt.Errorf("按 token 查询分享失败: %w", err)
	}
	if exp != nil {
		t := tt(*exp)
		sh.ExpiresAt = &t
	}
	sh.CreatedAt = tt(ca)
	sh.RequireCode = sh.ExtractCodeHash != nil
	return sh, nil
}

// DeleteShare 删除自己的分享。
func (s *SqliteStore) DeleteShare(ctx context.Context, userID, id string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM shares WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return false, fmt.Errorf("删除分享失败: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// IncrementDownload 下载次数原子自增（带剩余次数守卫）。
func (s *SqliteStore) IncrementDownload(ctx context.Context, id string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE shares SET downloads = downloads + 1
		 WHERE id = ? AND (max_downloads IS NULL OR downloads < max_downloads)`, id)
	if err != nil {
		return false, fmt.Errorf("更新下载次数失败: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// SubtreeFiles 收集分享根节点下整棵子树（含根）。
func (s *SqliteStore) SubtreeFiles(ctx context.Context, rootID string) ([]File, error) {
	rows, err := s.db.QueryContext(ctx, `
		WITH RECURSIVE sub AS (
			SELECT id FROM files WHERE id = ?
			UNION ALL
			SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
		)
		SELECT `+sqliteFileCols+` FROM files WHERE id IN (SELECT id FROM sub)
		ORDER BY parent_id IS NULL DESC, is_dir DESC, name ASC`, rootID)
	if err != nil {
		return nil, fmt.Errorf("收集分享子树失败: %w", err)
	}
	defer rows.Close()
	files := make([]File, 0)
	for rows.Next() {
		f, err := scanFileLiteRows(rows)
		if err != nil {
			return nil, fmt.Errorf("扫描子树行失败: %w", err)
		}
		files = append(files, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历分享子树失败: %w", err)
	}
	return files, nil
}
