// disk.go —— 单机模式对象存储实现（LOCAL_MODE=1）：
// 对象键 → DATA_DIR/objects/<key> 文件；分块上传 → DATA_DIR/uploads/<uploadID>/<partNo>，
// 合并时按序拼接（临时文件 + rename 保证原子性）后删除中间文件。
// 零外部依赖，任何路径都不依赖网络。
package object

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// DiskStore 本地磁盘对象存储实现。
type DiskStore struct {
	base string // DATA_DIR 根目录
}

// NewDisk 构造磁盘存储并确保目录结构（幂等）。
func NewDisk(dataDir string) (*DiskStore, error) {
	d := &DiskStore{base: dataDir}
	if err := os.MkdirAll(filepath.Join(d.base, "objects"), 0o755); err != nil {
		return nil, fmt.Errorf("创建对象目录失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(d.base, "uploads"), 0o755); err != nil {
		return nil, fmt.Errorf("创建上传目录失败: %w", err)
	}
	return d, nil
}

// objectPath 对象键 → 磁盘绝对路径（含防目录穿越校验）。
func (d *DiskStore) objectPath(key string) (string, error) {
	clean := filepath.Clean(strings.ReplaceAll(key, "\\", "/"))
	if clean == "." || strings.HasPrefix(clean, "..") || strings.Contains(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("非法对象键: %s", key)
	}
	p := filepath.Join(d.base, "objects", filepath.FromSlash(clean))
	return p, nil
}

// uploadDir 分块会话目录。
func (d *DiskStore) uploadDir(uploadID string) (string, error) {
	if strings.ContainsAny(uploadID, `/\`) || uploadID == "" || uploadID == "." || uploadID == ".." {
		return "", fmt.Errorf("非法上传会话 ID")
	}
	return filepath.Join(d.base, "uploads", uploadID), nil
}

// Ping 磁盘存储恒可用。
func (d *DiskStore) Ping(ctx context.Context) error { return nil }

// EnsureBucket 确保目录结构（幂等，已由 NewDisk 完成）。
func (d *DiskStore) EnsureBucket(ctx context.Context) error { return nil }

// CreateMultipart 创建分块上传会话（目录作为会话容器）。
func (d *DiskStore) CreateMultipart(ctx context.Context, key, contentType string) (string, error) {
	_ = key // 磁盘实现的分块与目标键无关，仅以 uploadID 隔离
	uploadID := uuid.NewString()
	dir, err := d.uploadDir(uploadID)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建上传会话失败: %w", err)
	}
	return uploadID, nil
}

// UploadPart 写入单个分块（临时文件 + rename 原子落盘；ETag 用数据 sha256 简化）。
func (d *DiskStore) UploadPart(ctx context.Context, key, uploadID string, partNumber int32, data []byte) (string, error) {
	dir, err := d.uploadDir(uploadID)
	if err != nil {
		return "", err
	}
	final := filepath.Join(dir, fmt.Sprintf("%06d.part", partNumber))
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", fmt.Errorf("写入分块失败: %w", err)
	}
	if err := os.Rename(tmp, final); err != nil {
		return "", fmt.Errorf("分块落盘失败: %w", err)
	}
	return fmt.Sprintf("%d-%d", partNumber, len(data)), nil
}

// ListParts 扫描会话目录，返回已上传分块列表。
func (d *DiskStore) ListParts(ctx context.Context, key, uploadID string) ([]PartInfo, error) {
	dir, err := d.uploadDir(uploadID)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []PartInfo{}, nil
		}
		return nil, fmt.Errorf("列举分块失败: %w", err)
	}
	parts := make([]PartInfo, 0)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".part") {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimSuffix(e.Name(), ".part"), ".tmp"))
		if err != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		parts = append(parts, PartInfo{Number: int32(n), ETag: e.Name(), Size: info.Size()})
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].Number < parts[j].Number })
	return parts, nil
}

// CompleteMultipart 按分块编号顺序拼接为最终对象（临时文件 + rename 原子性），随后清理会话。
func (d *DiskStore) CompleteMultipart(ctx context.Context, key, uploadID string, parts []PartInfo) (string, error) {
	dir, err := d.uploadDir(uploadID)
	if err != nil {
		return "", err
	}
	finalPath, err := d.objectPath(key)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(finalPath), 0o755); err != nil {
		return "", fmt.Errorf("创建目标目录失败: %w", err)
	}
	tmpPath := finalPath + ".tmp"
	out, err := os.Create(tmpPath)
	if err != nil {
		return "", fmt.Errorf("创建目标文件失败: %w", err)
	}
	ok := false
	defer func() {
		_ = out.Close()
		if !ok {
			_ = os.Remove(tmpPath)
		}
	}()
	for _, p := range parts {
		f, err := os.Open(filepath.Join(dir, fmt.Sprintf("%06d.part", p.Number)))
		if err != nil {
			return "", fmt.Errorf("读取分块 %d 失败: %w", p.Number, err)
		}
		_, copyErr := io.Copy(out, f)
		_ = f.Close()
		if copyErr != nil {
			return "", fmt.Errorf("拼接分块 %d 失败: %w", p.Number, copyErr)
		}
	}
	if err := out.Sync(); err != nil {
		return "", fmt.Errorf("同步文件失败: %w", err)
	}
	if err := out.Close(); err != nil {
		return "", fmt.Errorf("关闭文件失败: %w", err)
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return "", fmt.Errorf("最终对象落盘失败: %w", err)
	}
	ok = true
	_ = os.RemoveAll(dir) // 清理会话分块目录
	return "", nil
}

// AbortMultipart 中止会话并清理分块目录。
func (d *DiskStore) AbortMultipart(ctx context.Context, key, uploadID string) error {
	dir, err := d.uploadDir(uploadID)
	if err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

// GetObject 按 Range 读取对象（io.NewSectionReader 实现偏移与长度）。
// rng 为空表示全量；如 "bytes=0-1023"。调用方负责关闭返回的 Reader。
func (d *DiskStore) GetObject(ctx context.Context, key, rng string) (io.ReadCloser, *ObjectInfo, error) {
	p, err := d.objectPath(key)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, ErrObjectNotFound
		}
		return nil, nil, fmt.Errorf("打开对象失败: %w", err)
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, fmt.Errorf("获取对象信息失败: %w", err)
	}
	size := st.Size()

	info := &ObjectInfo{
		ContentLength: &size,
	}
	var reader io.Reader = f
	if rng != "" {
		start, length, err := parseRange(rng, size)
		if err != nil {
			_ = f.Close()
			return nil, nil, err
		}
		reader = io.NewSectionReader(f, start, length)
		info.ContentLength = &length
		cr := fmt.Sprintf("bytes %d-%d/%d", start, start+length-1, size)
		info.ContentRange = &cr
	}
	return &sectionReadCloser{Reader: reader, closer: f}, info, nil
}

// parseRange 解析 "bytes=a-b" 为 (偏移, 长度)。仅支持单段闭区间。
func parseRange(rng string, size int64) (int64, int64, error) {
	spec := strings.TrimPrefix(rng, "bytes=")
	if spec == rng {
		return 0, 0, fmt.Errorf("非法 Range: %s", rng)
	}
	parts := strings.SplitN(spec, "-", 2)
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, fmt.Errorf("非法 Range: %s", rng)
	}
	end := size - 1
	if len(parts) == 2 && parts[1] != "" {
		e, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || e < start {
			return 0, 0, fmt.Errorf("非法 Range: %s", rng)
		}
		if e < size {
			end = e
		}
	}
	return start, end - start + 1, nil
}

// sectionReadCloser 包装 SectionReader，关闭底层文件。
type sectionReadCloser struct {
	io.Reader
	closer *os.File
}

func (s *sectionReadCloser) Close() error { return s.closer.Close() }

// HeadObject 返回对象大小。
func (d *DiskStore) HeadObject(ctx context.Context, key string) (int64, error) {
	p, err := d.objectPath(key)
	if err != nil {
		return 0, err
	}
	st, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, ErrObjectNotFound
		}
		return 0, fmt.Errorf("获取对象信息失败: %w", err)
	}
	return st.Size(), nil
}

// RemoveObjects 批量删除对象（逐键 RemoveAll，目录不存在视为成功）。
func (d *DiskStore) RemoveObjects(ctx context.Context, keys []string) error {
	for _, key := range keys {
		p, err := d.objectPath(key)
		if err != nil {
			continue
		}
		if err := os.RemoveAll(p); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("删除对象失败(%s): %w", key, err)
		}
	}
	return nil
}
