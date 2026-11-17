// disk.go —— 单机模式缓存实现（LOCAL_MODE=1）：
// 用本地磁盘文件承载 Cache 接口（带 TTL），替代 Redis。
// 上传会话元数据、登录限流等均落盘于 DATA_DIR/cache，零外部依赖。
package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// DiskCache 本地磁盘缓存实现（文件 per key，值含过期时间戳）。
type DiskCache struct {
	dir string
}

// NewDisk 构造磁盘缓存并确保目录存在。
func NewDisk(dir string) (*DiskCache, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("创建缓存目录失败: %w", err)
	}
	return &DiskCache{dir: dir}, nil
}

func (d *DiskCache) keyPath(key string) string {
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(d.dir, hex.EncodeToString(sum[:])+".json")
}

type diskEntry struct {
	Value   string `json:"v"`
	Expires int64  `json:"e"` // unix 秒；0 = 永不过期
}

func (d *DiskCache) read(key string) (diskEntry, bool) {
	raw, err := os.ReadFile(d.keyPath(key))
	if err != nil {
		return diskEntry{}, false
	}
	var e diskEntry
	if err := json.Unmarshal(raw, &e); err != nil {
		return diskEntry{}, false
	}
	if e.Expires > 0 && time.Now().Unix() > e.Expires {
		_ = os.Remove(d.keyPath(key))
		return diskEntry{}, false
	}
	return e, true
}

// Get 读取键值；不存在或过期返回 ErrMiss。
func (d *DiskCache) Get(ctx context.Context, key string) (string, error) {
	e, ok := d.read(key)
	if !ok {
		return "", ErrMiss
	}
	return e.Value, nil
}

// Set 写入键值（临时文件 + rename 原子落盘）。
func (d *DiskCache) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	e := diskEntry{Value: value}
	if ttl > 0 {
		e.Expires = time.Now().Add(ttl).Unix()
	}
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	p := d.keyPath(key)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Del 删除一个或多个键。
func (d *DiskCache) Del(ctx context.Context, keys ...string) error {
	for _, k := range keys {
		_ = os.Remove(d.keyPath(k))
	}
	return nil
}

// LoginAttempt 同 IP 登录限流计数（分钟窗口，与 Redis 实现语义一致）。
func (d *DiskCache) LoginAttempt(ctx context.Context, ip string) (int64, error) {
	key := "login:attempt:" + ip
	n := int64(0)
	if e, ok := d.read(key); ok {
		n, _ = strconv.ParseInt(e.Value, 10, 64)
	}
	n++
	// 计数器覆盖写时带 1 分钟窗口
	e := diskEntry{Value: strconv.FormatInt(n, 10), Expires: time.Now().Add(time.Minute).Unix()}
	data, _ := json.Marshal(e)
	p := d.keyPath(key)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return n, err
	}
	_ = os.Rename(tmp, p)
	return n, nil
}

// Ping 磁盘缓存恒可用。
func (d *DiskCache) Ping(ctx context.Context) error { return nil }

// Enabled 磁盘缓存始终启用（单机模式下承担上传会话与限流职责）。
func (d *DiskCache) Enabled() bool { return true }

// Close 无资源需释放。
func (d *DiskCache) Close() error { return nil }

var _ Cache = (*DiskCache)(nil)
var _ = errors.Is // 保持 errors 导入（ErrMiss 定义于 cache.go）
