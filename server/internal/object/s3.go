// Package object 封装 MinIO（S3 API）对象存储操作：
// bucket 确保、分块上传五个方法（CreateMultipartUpload / UploadPart / ListParts /
// CompleteMultipartUpload / AbortMultipartUpload）、带 Range 参数的 GetObject 流式读取、
// HeadObject 大小校验、批量删除（DeleteObjects）。
package object

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3Store MinIO/S3 对象存储实现（ErrObjectNotFound/PartInfo/ObjectInfo 定义于 object.go）。
type S3Store struct {
	client *s3.Client
	bucket string
}

// NewS3 构造 S3 客户端。
// endpoint 可带或不带 scheme；缺省时按 useSSL 决定 http/https。
func NewS3(ctx context.Context, endpoint, region, accessKey, secretKey, bucket string, useSSL bool) (*S3Store, error) {
	if !strings.Contains(endpoint, "://") {
		scheme := "http"
		if useSSL {
			scheme = "https"
		}
		endpoint = scheme + "://" + endpoint
	}
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
	)
	if err != nil {
		return nil, fmt.Errorf("加载 AWS SDK 配置失败: %w", err)
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(strings.TrimRight(endpoint, "/"))
		o.UsePathStyle = true // MinIO 使用 Path-Style 寻址
	})
	return &S3Store{client: client, bucket: bucket}, nil
}

// Ping 探测对象存储可用性（HeadBucket）。
func (o *S3Store) Ping(ctx context.Context) error {
	_, err := o.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(o.bucket)})
	return err
}

// EnsureBucket 确保 bucket 存在，不存在则创建（幂等，启动时调用）。
func (o *S3Store) EnsureBucket(ctx context.Context) error {
	_, err := o.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(o.bucket)})
	if err == nil {
		return nil
	}
	var nf *types.NotFound
	if !errors.As(err, &nf) {
		return fmt.Errorf("检查 bucket 失败: %w", err)
	}
	if _, err := o.client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(o.bucket)}); err != nil {
		return fmt.Errorf("创建 bucket 失败: %w", err)
	}
	return nil
}

// CreateMultipart 创建分块上传会话，返回 S3 upload_id。
func (o *S3Store) CreateMultipart(ctx context.Context, key, contentType string) (string, error) {
	out, err := o.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket:      aws.String(o.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", fmt.Errorf("CreateMultipartUpload 失败: %w", err)
	}
	return aws.ToString(out.UploadId), nil
}

// UploadPart 上传单个分块（partNumber 从 1 开始），返回该块 ETag。
// data 为内存中的整块（契约限制单块 ≤64MiB），bytes.Reader 便于 SDK 计算 Content-Length。
func (o *S3Store) UploadPart(ctx context.Context, key, uploadID string, partNumber int32, data []byte) (string, error) {
	out, err := o.client.UploadPart(ctx, &s3.UploadPartInput{
		Bucket:     aws.String(o.bucket),
		Key:        aws.String(key),
		UploadId:   aws.String(uploadID),
		PartNumber: aws.Int32(partNumber),
		Body:       bytes.NewReader(data),
	})
	if err != nil {
		return "", fmt.Errorf("UploadPart 失败: %w", err)
	}
	return aws.ToString(out.ETag), nil
}

// (PartInfo 定义于 object.go)
// ListParts 列举会话全部已上传分块（按 PartNumberMarker 翻页，兼容 >1000 块）。
func (o *S3Store) ListParts(ctx context.Context, key, uploadID string) ([]PartInfo, error) {
	parts := make([]PartInfo, 0)
	var marker *string
	// 安全护栏：最多翻 100 页（1000×100 = 10 万分块），防止异常实现（如 s3mock 在
	// 未截断时也返回 NextPartNumberMarker）导致无限分页。
	for page := 0; page < 100; page++ {
		out, err := o.client.ListParts(ctx, &s3.ListPartsInput{
			Bucket:           aws.String(o.bucket),
			Key:              aws.String(key),
			UploadId:         aws.String(uploadID),
			MaxParts:         aws.Int32(1000),
			PartNumberMarker: marker,
		})
		if err != nil {
			return nil, fmt.Errorf("ListParts 失败: %w", err)
		}
		for _, p := range out.Parts {
			parts = append(parts, PartInfo{
				Number: aws.ToInt32(p.PartNumber),
				ETag:   aws.ToString(p.ETag),
				Size:   aws.ToInt64(p.Size),
			})
		}
		// 必须同时满足「已截断」与「marker 有效」才继续翻页：
		// 仅判断 marker 非空会与 s3mock 这类“未截断也回填 marker”的实现死循环。
		truncated := out.IsTruncated != nil && *out.IsTruncated
		if !truncated || out.NextPartNumberMarker == nil || *out.NextPartNumberMarker == "" {
			break
		}
		marker = out.NextPartNumberMarker
	}
	// 防御性排序：按分块编号升序
	sort.Slice(parts, func(i, j int) bool { return parts[i].Number < parts[j].Number })
	return parts, nil
}

// CompleteMultipart 合并全部已传分块为最终对象，返回对象 ETag。
func (o *S3Store) CompleteMultipart(ctx context.Context, key, uploadID string, parts []PartInfo) (string, error) {
	completed := make([]types.CompletedPart, 0, len(parts))
	for _, p := range parts {
		completed = append(completed, types.CompletedPart{
			ETag:       aws.String(p.ETag),
			PartNumber: aws.Int32(p.Number),
		})
	}
	out, err := o.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket:          aws.String(o.bucket),
		Key:             aws.String(key),
		UploadId:        aws.String(uploadID),
		MultipartUpload: &types.CompletedMultipartUpload{Parts: completed},
	})
	if err != nil {
		return "", fmt.Errorf("CompleteMultipartUpload 失败: %w", err)
	}
	return aws.ToString(out.ETag), nil
}

// AbortMultipart 中止分块上传会话。
func (o *S3Store) AbortMultipart(ctx context.Context, key, uploadID string) error {
	_, err := o.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket:   aws.String(o.bucket),
		Key:      aws.String(key),
		UploadId: aws.String(uploadID),
	})
	if err != nil {
		return fmt.Errorf("AbortMultipartUpload 失败: %w", err)
	}
	return nil
}

// (ObjectInfo 定义于 object.go)
// GetObject 按 Range 读取对象并流式返回 Body。
// rng 为空表示全量；如 "bytes=0-1023"。调用方负责关闭 Body。
func (o *S3Store) GetObject(ctx context.Context, key, rng string) (io.ReadCloser, *ObjectInfo, error) {
	in := &s3.GetObjectInput{Bucket: aws.String(o.bucket), Key: aws.String(key)}
	if rng != "" {
		in.Range = aws.String(rng)
	}
	out, err := o.client.GetObject(ctx, in)
	if err != nil {
		var nsk *types.NoSuchKey
		if errors.As(err, &nsk) {
			return nil, nil, ErrObjectNotFound
		}
		return nil, nil, fmt.Errorf("GetObject 失败: %w", err)
	}
	info := &ObjectInfo{
		ContentLength: out.ContentLength,
		ContentRange:  out.ContentRange,
		ETag:          out.ETag,
		ContentType:   out.ContentType,
	}
	return out.Body, info, nil
}

// HeadObject 返回对象大小（用于分块合并后的大小校验）。
func (o *S3Store) HeadObject(ctx context.Context, key string) (int64, error) {
	out, err := o.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(o.bucket), Key: aws.String(key)})
	if err != nil {
		var nf *types.NotFound
		if errors.As(err, &nf) {
			return 0, ErrObjectNotFound
		}
		return 0, fmt.Errorf("HeadObject 失败: %w", err)
	}
	return aws.ToInt64(out.ContentLength), nil
}

// RemoveObjects 批量删除对象（S3 单次最多 1000 个 key，自动分批）。
func (o *S3Store) RemoveObjects(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	for start := 0; start < len(keys); start += 1000 {
		end := start + 1000
		if end > len(keys) {
			end = len(keys)
		}
		batch := make([]types.ObjectIdentifier, 0, end-start)
		for _, k := range keys[start:end] {
			batch = append(batch, types.ObjectIdentifier{Key: aws.String(k)})
		}
		out, err := o.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(o.bucket),
			Delete: &types.Delete{Objects: batch, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return fmt.Errorf("DeleteObjects 失败: %w", err)
		}
		for _, e := range out.Errors {
			slog.Warn("删除单个对象失败",
				"key", aws.ToString(e.Key),
				"code", aws.ToString(e.Code),
				"message", aws.ToString(e.Message),
			)
		}
	}
	return nil
}
