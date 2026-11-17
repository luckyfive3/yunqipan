// Package object 提供文件对象存储抽象：
//   - Object 接口：api 层依赖的统一抽象（分块上传五方法 + 流式读取 + 批量删除）；
//   - S3Store：MinIO/S3 实现（默认，LOCAL_MODE=0）；
//   - DiskStore：本地磁盘实现（LOCAL_MODE=1，零外部依赖）。
package object

import (
	"context"
	"errors"
	"io"
)

// ErrObjectNotFound 对象不存在。
var ErrObjectNotFound = errors.New("对象不存在")

// PartInfo 已上传分块的信息（ListParts 是 received 的可靠真相源）。
type PartInfo struct {
	Number int32 // 分块编号（从 1 开始，客户端 0 基 index = Number-1）
	ETag   string
	Size   int64
}

// ObjectInfo GetObject 响应中的关键元数据（Content-Length / Content-Range 等按需透传）。
type ObjectInfo struct {
	ContentLength *int64
	ContentRange  *string
	ETag          *string
	ContentType   *string
}

// Object 文件对象存储接口（api 层只依赖该接口）。
// 实现：S3Store（MinIO/S3）与 DiskStore（本地磁盘单机模式）。
type Object interface {
	Ping(ctx context.Context) error
	EnsureBucket(ctx context.Context) error
	CreateMultipart(ctx context.Context, key, contentType string) (string, error)
	UploadPart(ctx context.Context, key, uploadID string, partNumber int32, data []byte) (string, error)
	ListParts(ctx context.Context, key, uploadID string) ([]PartInfo, error)
	CompleteMultipart(ctx context.Context, key, uploadID string, parts []PartInfo) (string, error)
	AbortMultipart(ctx context.Context, key, uploadID string) error
	GetObject(ctx context.Context, key, rng string) (io.ReadCloser, *ObjectInfo, error)
	HeadObject(ctx context.Context, key string) (int64, error)
	RemoveObjects(ctx context.Context, keys []string) error
}
