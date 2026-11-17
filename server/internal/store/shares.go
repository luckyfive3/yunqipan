// shares.go —— shares 表数据访问：创建/列表/删除/按 token 解析、
// 下载次数原子自增（契约 5.2 计数规则）、分享子树收集（WITH RECURSIVE）。

package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Share 分享模型（JSON 字段与契约 1.5 对齐）。
type Share struct {
	ID              string     `json:"id"`
	UserID          string     `json:"-"`
	FileID          string     `json:"file_id"`
	FileName        string     `json:"file_name"`
	Token           string     `json:"token"`
	ExtractCodeHash *string    `json:"-"`
	RequireCode     bool       `json:"require_code"`
	ExpiresAt       *time.Time `json:"expires_at"`    // null = 永久
	MaxDownloads    *int       `json:"max_downloads"` // null = 不限次
	Downloads       int        `json:"downloads"`
	CreatedAt       time.Time  `json:"created_at"`
	// 以下字段来自 files 联查，仅服务端使用，不参与序列化。
	IsDir bool  `json:"-"`
	Size  int64 `json:"-"`
}

// shareCols 统一的 shares 列顺序（与 scanShare 对应）。
const shareCols = `s.id::text, s.user_id::text, s.file_id::text, s.token, s.extract_code_hash, s.expires_at, s.max_downloads, s.downloads, s.created_at`

// scanShare 扫描一行 shares（不含 files 联查字段）。
func scanShare(r rowScanner) (Share, error) {
	var sh Share
	err := r.Scan(&sh.ID, &sh.UserID, &sh.FileID, &sh.Token, &sh.ExtractCodeHash, &sh.ExpiresAt, &sh.MaxDownloads, &sh.Downloads, &sh.CreatedAt)
	if err != nil {
		return Share{}, err
	}
	sh.RequireCode = sh.ExtractCodeHash != nil
	return sh, nil
}

// CreateShare 创建分享。
// token 冲突（23505）返回 ErrConflict；file 已被删除（23503）返回 ErrNotFound。
func (s *PgStore) CreateShare(ctx context.Context, userID, fileID, token string, codeHash *string, expiresAt *time.Time, maxDownloads *int) (Share, error) {
	sh, err := scanShare(s.pool.QueryRow(ctx,
		`INSERT INTO shares AS s (user_id, file_id, token, extract_code_hash, expires_at, max_downloads)
		 VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
		 RETURNING `+shareCols, userID, fileID, token, codeHash, expiresAt, maxDownloads))
	if err != nil {
		if isUniqueViolation(err) {
			return Share{}, ErrConflict
		}
		if isFKViolation(err) {
			return Share{}, ErrNotFound
		}
		return Share{}, fmt.Errorf("创建分享失败: %w", err)
	}
	var name string
	if err := s.pool.QueryRow(ctx, `SELECT name FROM files WHERE id = $1::uuid`, fileID).Scan(&name); err != nil {
		return Share{}, fmt.Errorf("查询分享文件名失败: %w", err)
	}
	sh.FileName = name
	return sh, nil
}

// ListShares 当前用户的分享列表（含 file_name，按创建时间倒序）。
func (s *PgStore) ListShares(ctx context.Context, userID string) ([]Share, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+shareCols+`, f.name, f.is_dir, f.size
		 FROM shares s JOIN files f ON f.id = s.file_id
		 WHERE s.user_id = $1::uuid
		 ORDER BY s.created_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("查询分享列表失败: %w", err)
	}
	defer rows.Close()
	shares := make([]Share, 0)
	for rows.Next() {
		var sh Share
		if err := rows.Scan(&sh.ID, &sh.UserID, &sh.FileID, &sh.Token, &sh.ExtractCodeHash, &sh.ExpiresAt, &sh.MaxDownloads, &sh.Downloads, &sh.CreatedAt, &sh.FileName, &sh.IsDir, &sh.Size); err != nil {
			return nil, fmt.Errorf("扫描分享行失败: %w", err)
		}
		sh.RequireCode = sh.ExtractCodeHash != nil
		shares = append(shares, sh)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历分享列表失败: %w", err)
	}
	return shares, nil
}

// GetShareByToken 按 token 查询分享（含根文件 name/is_dir/size，供 resolve 与下载用）。
func (s *PgStore) GetShareByToken(ctx context.Context, token string) (Share, error) {
	var sh Share
	err := s.pool.QueryRow(ctx,
		`SELECT `+shareCols+`, f.name, f.is_dir, f.size
		 FROM shares s JOIN files f ON f.id = s.file_id
		 WHERE s.token = $1`, token).Scan(
		&sh.ID, &sh.UserID, &sh.FileID, &sh.Token, &sh.ExtractCodeHash, &sh.ExpiresAt, &sh.MaxDownloads, &sh.Downloads, &sh.CreatedAt, &sh.FileName, &sh.IsDir, &sh.Size)
	if errors.Is(err, pgx.ErrNoRows) {
		return Share{}, ErrNotFound
	}
	if err != nil {
		return Share{}, fmt.Errorf("按 token 查询分享失败: %w", err)
	}
	sh.RequireCode = sh.ExtractCodeHash != nil
	return sh, nil
}

// DeleteShare 删除自己的分享；返回是否删除成功。
func (s *PgStore) DeleteShare(ctx context.Context, userID, id string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM shares WHERE id = $1::uuid AND user_id = $2::uuid`, id, userID)
	if err != nil {
		return false, fmt.Errorf("删除分享失败: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// IncrementDownload 下载次数原子自增（契约 5.2 计数规则）。
// max_downloads 为 NULL（不限次）或 downloads < max_downloads 时自增成功；
// 影响行数为 0 说明次数已耗尽。
func (s *PgStore) IncrementDownload(ctx context.Context, id string) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE shares SET downloads = downloads + 1
		 WHERE id = $1::uuid AND (max_downloads IS NULL OR downloads < max_downloads)`, id)
	if err != nil {
		return false, fmt.Errorf("更新下载次数失败: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// SubtreeFiles 用 WITH RECURSIVE 收集分享根节点下整棵子树（含根）。
func (s *PgStore) SubtreeFiles(ctx context.Context, rootID string) ([]File, error) {
	rows, err := s.pool.Query(ctx, `
		WITH RECURSIVE sub AS (
			SELECT id FROM files WHERE id = $1::uuid
			UNION ALL
			SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
		)
		SELECT `+fileCols+` FROM files WHERE id IN (SELECT id FROM sub)
		ORDER BY parent_id NULLS FIRST, is_dir DESC, name ASC`, rootID)
	if err != nil {
		return nil, fmt.Errorf("收集分享子树失败: %w", err)
	}
	defer rows.Close()
	files := make([]File, 0)
	for rows.Next() {
		f, err := scanFile(rows)
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
