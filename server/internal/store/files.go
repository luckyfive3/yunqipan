// files.go —— files 表数据访问：目录树查询、同层查重、mkdir/rename/move/delete、
// 上传完成入库（含配额终检）等。
// 同层重名校验统一使用 `parent_id IS NOT DISTINCT FROM $n`，
// 以正确处理 NULL parent_id（PostgreSQL 唯一约束对 NULL 不生效）。

package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// File 文件/目录元数据（与契约 1.5 FileMeta 对齐；UserID/ObjectKey 不序列化）。
type File struct {
	ID        string    `json:"id"`
	UserID    string    `json:"-"`
	ParentID  *string   `json:"parent_id"`
	Name      string    `json:"name"`
	IsDir     bool      `json:"is_dir"`
	Size      int64     `json:"size"`
	Mime      string    `json:"mime"`
	SHA256    *string   `json:"sha256"`
	Encrypted bool      `json:"encrypted"`
	ObjectKey *string   `json:"-"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// fileCols 统一的 SELECT 列顺序（与 scanFile 一一对应，SELECT/RETURNING 通用）。
const fileCols = `id::text, user_id::text, parent_id::text, name, is_dir, size, mime, sha256, encrypted, object_key, created_at, updated_at`

// rowScanner pgx.Row / pgx.Rows 共同的 Scan 接口。
type rowScanner interface {
	Scan(dest ...any) error
}

// queryer pgxpool.Pool 与 pgx.Tx 共同的查询接口（事务内外复用同一批 SQL 助手）。
type queryer interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// scanFile 按 fileCols 的顺序扫描一行。
func scanFile(r rowScanner) (File, error) {
	var f File
	err := r.Scan(&f.ID, &f.UserID, &f.ParentID, &f.Name, &f.IsDir, &f.Size, &f.Mime, &f.SHA256, &f.Encrypted, &f.ObjectKey, &f.CreatedAt, &f.UpdatedAt)
	return f, err
}

// ListChildren 列出某目录下的子项（目录在前、名称升序，契约 3.1）。
// parentID 为 nil 表示根目录。
func (s *PgStore) ListChildren(ctx context.Context, userID string, parentID *string) ([]File, error) {
	rows, err := s.pool.Query(ctx,
		"SELECT "+fileCols+" FROM files WHERE user_id = $1::uuid AND parent_id IS NOT DISTINCT FROM $2::uuid ORDER BY is_dir DESC, name ASC",
		userID, parentID)
	if err != nil {
		return nil, fmt.Errorf("查询目录内容失败: %w", err)
	}
	defer rows.Close()
	files := make([]File, 0)
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, fmt.Errorf("扫描文件行失败: %w", err)
		}
		files = append(files, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历目录内容失败: %w", err)
	}
	return files, nil
}

// ListAll 返回用户全部文件/目录（扁平数组，供 /files/tree 同步用）。
// 用 LIMIT 20001 探测节点数是否超过契约上限 20000。
func (s *PgStore) ListAll(ctx context.Context, userID string) ([]File, error) {
	rows, err := s.pool.Query(ctx,
		"SELECT "+fileCols+" FROM files WHERE user_id = $1::uuid ORDER BY parent_id NULLS FIRST, is_dir DESC, name ASC LIMIT 20001",
		userID)
	if err != nil {
		return nil, fmt.Errorf("查询文件树失败: %w", err)
	}
	defer rows.Close()
	files := make([]File, 0, 256)
	for rows.Next() {
		f, err := scanFile(rows)
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

// GetFileByID 按 ID 查询（不校验归属，调用方自行判断）。
func (s *PgStore) GetFileByID(ctx context.Context, id string) (File, error) {
	f, err := scanFile(s.pool.QueryRow(ctx, "SELECT "+fileCols+" FROM files WHERE id = $1::uuid", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, fmt.Errorf("按 ID 查询文件失败: %w", err)
	}
	return f, nil
}

// childExists 同层同名查重（NULL parent_id 下唯一约束不生效，必须显式查重）。
// excludeID 非空时排除自身（rename/move 用）。
func childExists(ctx context.Context, q queryer, userID string, parentID *string, name, excludeID string) (bool, error) {
	sql := `SELECT EXISTS(
		SELECT 1 FROM files
		WHERE user_id = $1::uuid AND parent_id IS NOT DISTINCT FROM $2::uuid AND name = $3`
	var exists bool
	var err error
	if excludeID != "" {
		sql += ` AND id <> $4::uuid)`
		err = q.QueryRow(ctx, sql, userID, parentID, name, excludeID).Scan(&exists)
	} else {
		sql += `)`
		err = q.QueryRow(ctx, sql, userID, parentID, name).Scan(&exists)
	}
	if err != nil {
		return false, err
	}
	return exists, nil
}

// depthOf 计算节点到根目录的层数（根目录本身为 1 层）。
func depthOf(ctx context.Context, q queryer, userID, id string) (int, error) {
	var depth int
	err := q.QueryRow(ctx, `
		WITH RECURSIVE ancestors AS (
			SELECT id, parent_id, 1 AS depth FROM files WHERE id = $1::uuid AND user_id = $2::uuid
			UNION ALL
			SELECT f.id, f.parent_id, a.depth + 1 FROM files f JOIN ancestors a ON f.id = a.parent_id
		)
		SELECT COALESCE(MAX(depth), 0) FROM ancestors`, id, userID).Scan(&depth)
	if err != nil {
		return 0, err
	}
	return depth, nil
}

// CreateDir 在 parentID 下创建目录。
// 事务内校验：父目录归属/类型、目录深度上限、同层查重；并发兜底依赖唯一约束。
func (s *PgStore) CreateDir(ctx context.Context, userID string, parentID *string, name string) (File, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return File{}, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if parentID != nil {
		// 父目录必须存在、属于当前用户且是目录
		var isDir bool
		err := tx.QueryRow(ctx, `SELECT is_dir FROM files WHERE id = $1::uuid AND user_id = $2::uuid`, *parentID, userID).Scan(&isDir)
		if errors.Is(err, pgx.ErrNoRows) {
			return File{}, ErrParentNotFound
		}
		if err != nil {
			return File{}, fmt.Errorf("查询父目录失败: %w", err)
		}
		if !isDir {
			return File{}, ErrParentNotFound
		}
		// 深度校验：父目录层数达到 64 时新目录将超出上限
		depth, err := depthOf(ctx, tx, userID, *parentID)
		if err != nil {
			return File{}, fmt.Errorf("计算目录深度失败: %w", err)
		}
		if depth >= maxTreeDepth {
			return File{}, ErrDepthExceeded
		}
	}

	// 同层重名校验（事务内显式查重，NULL parent_id 也生效）
	exists, err := childExists(ctx, tx, userID, parentID, name, "")
	if err != nil {
		return File{}, fmt.Errorf("目录查重失败: %w", err)
	}
	if exists {
		return File{}, ErrConflict
	}

	f, err := scanFile(tx.QueryRow(ctx, `
		INSERT INTO files (user_id, parent_id, name, is_dir, mime)
		VALUES ($1::uuid, $2::uuid, $3, true, 'inode/directory')
		RETURNING `+fileCols, userID, parentID, name))
	if err != nil {
		if isUniqueViolation(err) {
			return File{}, ErrConflict // 并发插入兜底
		}
		return File{}, fmt.Errorf("创建目录失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, fmt.Errorf("提交事务失败: %w", err)
	}
	return f, nil
}

// RenameFile 重命名文件/目录（事务内归属校验 + 查重后更新）。
func (s *PgStore) RenameFile(ctx context.Context, userID, id, name string) (File, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return File{}, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	target, err := scanFile(tx.QueryRow(ctx, "SELECT "+fileCols+" FROM files WHERE id = $1::uuid", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, fmt.Errorf("查询目标失败: %w", err)
	}
	if target.UserID != userID {
		return File{}, ErrForbidden
	}

	exists, err := childExists(ctx, tx, userID, target.ParentID, name, id)
	if err != nil {
		return File{}, fmt.Errorf("重命名查重失败: %w", err)
	}
	if exists {
		return File{}, ErrConflict
	}

	f, err := scanFile(tx.QueryRow(ctx, `
		UPDATE files SET name = $3, updated_at = now()
		WHERE id = $2::uuid AND user_id = $1::uuid
		RETURNING `+fileCols, userID, id, name))
	if err != nil {
		return File{}, fmt.Errorf("重命名失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, fmt.Errorf("提交事务失败: %w", err)
	}
	return f, nil
}

// MoveFile 移动文件/目录到新父目录。
// 事务内校验：目标归属、新父目录归属/类型、防环（目录不能移入自己的子孙）、
// 目录深度上限、同层同名冲突。
func (s *PgStore) MoveFile(ctx context.Context, userID, id string, parentID *string) (File, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return File{}, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	target, err := scanFile(tx.QueryRow(ctx, "SELECT "+fileCols+" FROM files WHERE id = $1::uuid", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, fmt.Errorf("查询目标失败: %w", err)
	}
	if target.UserID != userID {
		return File{}, ErrForbidden
	}

	if parentID != nil {
		// 新父目录必须存在、属于当前用户且是目录
		var isDir bool
		err := tx.QueryRow(ctx, `SELECT is_dir FROM files WHERE id = $1::uuid AND user_id = $2::uuid`, *parentID, userID).Scan(&isDir)
		if errors.Is(err, pgx.ErrNoRows) {
			return File{}, ErrParentNotFound
		}
		if err != nil {
			return File{}, fmt.Errorf("查询目标目录失败: %w", err)
		}
		if !isDir {
			return File{}, ErrParentNotFound
		}

		if target.IsDir {
			// 防环：新父目录不能位于目标目录的子孙中
			var cycle bool
			err := tx.QueryRow(ctx, `
				WITH RECURSIVE sub AS (
					SELECT id FROM files WHERE id = $1::uuid
					UNION ALL
					SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
				)
				SELECT EXISTS(SELECT 1 FROM sub WHERE id = $2::uuid)`, id, *parentID).Scan(&cycle)
			if err != nil {
				return File{}, fmt.Errorf("防环校验失败: %w", err)
			}
			if cycle {
				return File{}, ErrCycle
			}
		}
		// 深度校验：新位置深度 = 新父目录层数 + 1，达到 64 层即超限
		depth, err := depthOf(ctx, tx, userID, *parentID)
		if err != nil {
			return File{}, fmt.Errorf("计算目录深度失败: %w", err)
		}
		if depth >= maxTreeDepth {
			return File{}, ErrDepthExceeded
		}
	}

	// 同层同名冲突（排除自身）
	exists, err := childExists(ctx, tx, userID, parentID, target.Name, id)
	if err != nil {
		return File{}, fmt.Errorf("移动查重失败: %w", err)
	}
	if exists {
		return File{}, ErrConflict
	}

	f, err := scanFile(tx.QueryRow(ctx, `
		UPDATE files SET parent_id = $3::uuid, updated_at = now()
		WHERE id = $2::uuid AND user_id = $1::uuid
		RETURNING `+fileCols, userID, id, parentID))
	if err != nil {
		return File{}, fmt.Errorf("移动失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, fmt.Errorf("提交事务失败: %w", err)
	}
	return f, nil
}

// DeleteFile 删除文件或目录（recursive=true 时递归删除整棵子树）。
// 事务内：递归 CTE 收集子孙 → 汇总大小与对象键 → 删行 → 扣减配额。
// 返回释放的配额与待删除的对象键列表（由调用方在事务提交后执行对象删除）。
func (s *PgStore) DeleteFile(ctx context.Context, userID, id string, recursive bool) (freed int64, keys []string, err error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, nil, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	root, err := scanFile(tx.QueryRow(ctx, "SELECT "+fileCols+" FROM files WHERE id = $1::uuid", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, ErrNotFound
	}
	if err != nil {
		return 0, nil, fmt.Errorf("查询目标失败: %w", err)
	}
	if root.UserID != userID {
		return 0, nil, ErrForbidden
	}
	// 契约 3.5：目录必须带 recursive=true，否则视为非法输入
	if root.IsDir && !recursive {
		return 0, nil, ErrInvalidInput
	}

	// 递归 CTE 收集整棵子树（含根），拿到每个节点的对象键与大小
	rows, err := tx.Query(ctx, `
		WITH RECURSIVE sub AS (
			SELECT id, is_dir, size, object_key FROM files WHERE id = $1::uuid
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

	// 删行（同一 CTE 重复使用，根与子孙一并删除）
	if _, err := tx.Exec(ctx, `
		WITH RECURSIVE sub AS (
			SELECT id FROM files WHERE id = $1::uuid
			UNION ALL
			SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
		)
		DELETE FROM files WHERE id IN (SELECT id FROM sub)`, id); err != nil {
		return 0, nil, fmt.Errorf("删除文件行失败: %w", err)
	}

	// 扣减配额（GREATEST 防止并发场景下扣成负数）
	if total > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE users SET quota_used = GREATEST(quota_used - $2, 0), updated_at = now()
			WHERE id = $1::uuid`, userID, total); err != nil {
			return 0, nil, fmt.Errorf("扣减配额失败: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, nil, fmt.Errorf("提交事务失败: %w", err)
	}
	return total, keys, nil
}

// CreateFileComplete 分块上传完成后入库：
// 事务内 查重 → 校验父目录 → INSERT files → 配额终检（带守卫的原子 UPDATE，杜绝并发超卖）。
func (s *PgStore) CreateFileComplete(ctx context.Context, userID, id string, parentID *string, name string, size int64, mimeType string, sha256 *string, encrypted bool, objectKey string) (File, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return File{}, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	exists, err := childExists(ctx, tx, userID, parentID, name, "")
	if err != nil {
		return File{}, fmt.Errorf("查重失败: %w", err)
	}
	if exists {
		return File{}, ErrConflict
	}

	if parentID != nil {
		var isDir bool
		err := tx.QueryRow(ctx, `SELECT is_dir FROM files WHERE id = $1::uuid AND user_id = $2::uuid`, *parentID, userID).Scan(&isDir)
		if errors.Is(err, pgx.ErrNoRows) {
			return File{}, ErrParentNotFound
		}
		if err != nil {
			return File{}, fmt.Errorf("查询父目录失败: %w", err)
		}
		if !isDir {
			return File{}, ErrParentNotFound
		}
	}

	f, err := scanFile(tx.QueryRow(ctx, `
		INSERT INTO files (id, user_id, parent_id, name, is_dir, size, mime, sha256, encrypted, object_key)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, false, $5, $6, $7, $8, $9)
		RETURNING `+fileCols, id, userID, parentID, name, size, mimeType, sha256, encrypted, objectKey))
	if err != nil {
		if isUniqueViolation(err) {
			return File{}, ErrConflict
		}
		return File{}, fmt.Errorf("插入文件行失败: %w", err)
	}

	// 配额终检：quota_total=0 表示不限容量；影响行数为 0 即配额不足（或用户被删除）
	tag, err := tx.Exec(ctx, `
		UPDATE users SET quota_used = quota_used + $2, updated_at = now()
		WHERE id = $1::uuid AND (quota_total = 0 OR quota_used + $2 <= quota_total)`, userID, size)
	if err != nil {
		return File{}, fmt.Errorf("更新配额失败: %w", err)
	}
	if tag.RowsAffected() == 0 {
		var total, used int64
		err := tx.QueryRow(ctx, `SELECT quota_total, quota_used FROM users WHERE id = $1::uuid`, userID).Scan(&total, &used)
		if errors.Is(err, pgx.ErrNoRows) {
			return File{}, ErrNotFound
		}
		if err != nil {
			return File{}, fmt.Errorf("查询配额失败: %w", err)
		}
		return File{}, ErrQuotaExceeded
	}

	if err := tx.Commit(ctx); err != nil {
		return File{}, fmt.Errorf("提交事务失败: %w", err)
	}
	return f, nil
}
