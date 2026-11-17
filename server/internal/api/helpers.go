// helpers.go —— API 层共享工具：文件名/提取码/参数校验、HTTP Range 头解析、
// 预览白名单、客户端 IP、对象键规则、ETag 处理。
package api

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// 契约 1.4 的边界常量。
// S3 分块上传要求：除最后一块外，每块必须 ≥ 5 MiB，因此最小分块为 5 MiB。
const (
	maxNameBytes = 255
	minChunkSize = 5 << 20  // 5 MiB（S3 非末块最小尺寸）
	maxChunkSize = 64 << 20 // 64 MiB
)

// Range 解析结果哨兵。
var (
	errRangeInvalid       = errors.New("Range 头格式非法")
	errRangeUnsatisfiable = errors.New("Range 请求范围不满足")
)

// validateFileName 校验文件名/目录名：1~255 字节、不含非法字符与控制字符、非 "." / ".."。
func validateFileName(name string) error {
	b := []byte(name)
	if len(b) == 0 || len(b) > maxNameBytes {
		return errors.New("名称长度需为 1~255 字节")
	}
	if name == "." || name == ".." {
		return errors.New("名称不能为 . 或 ..")
	}
	if strings.ContainsAny(name, `/\:*?"<>|`) {
		return errors.New("名称不能包含 \\ / : * ? \" < > | 字符")
	}
	for _, c := range b {
		if c < 0x20 || c == 0x7f {
			return errors.New("名称不能包含控制字符")
		}
	}
	return nil
}

// validateExtractCode 提取码规则：4-8 位数字或字母（契约 5.1）。
func validateExtractCode(code string) error {
	if len(code) < 4 || len(code) > 8 {
		return errors.New("提取码需为 4-8 位")
	}
	for _, c := range code {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return errors.New("提取码只能包含数字和字母")
		}
	}
	return nil
}

// validUUID 校验字符串是否为合法 UUID。
func validUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
}

// parseRangeHeader 解析单段 Range 头（bytes=start-end / bytes=start- / bytes=-suffix）。
// 返回闭区间 [start, end]（已按 size 截断）；无 Range 头时 hasRange=false。
// 多段 Range 与非法格式返回 errRangeInvalid；起始超出文件大小时返回 errRangeUnsatisfiable。
func parseRangeHeader(r *http.Request, size int64) (start, end int64, hasRange bool, err error) {
	h := r.Header.Get("Range")
	if h == "" {
		return 0, 0, false, nil
	}
	if !strings.HasPrefix(h, "bytes=") {
		return 0, 0, true, errRangeInvalid
	}
	spec := strings.TrimPrefix(h, "bytes=")
	if strings.Contains(spec, ",") {
		// 契约仅支持单段 Range（bytes=start-end）
		return 0, 0, true, errRangeInvalid
	}
	if size <= 0 {
		return 0, 0, true, errRangeUnsatisfiable
	}
	if strings.HasPrefix(spec, "-") {
		// 后缀区间 bytes=-N：取文件末尾 N 字节
		n, perr := strconv.ParseInt(strings.TrimPrefix(spec, "-"), 10, 64)
		if perr != nil || n <= 0 {
			return 0, 0, true, errRangeInvalid
		}
		start = size - n
		if start < 0 {
			start = 0
		}
		return start, size - 1, true, nil
	}
	parts := strings.SplitN(spec, "-", 2)
	start, err = strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 {
		return 0, 0, true, errRangeInvalid
	}
	if start >= size {
		return 0, 0, true, errRangeUnsatisfiable
	}
	if parts[1] == "" {
		end = size - 1
	} else {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, 0, true, errRangeInvalid
		}
		if end >= size {
			end = size - 1
		}
		if end < start {
			return 0, 0, true, errRangeUnsatisfiable
		}
	}
	return start, end, true, nil
}

// previewMimeAllowed 预览白名单（契约 3.6）。
func previewMimeAllowed(mimeType string) bool {
	if strings.HasPrefix(mimeType, "image/") ||
		strings.HasPrefix(mimeType, "video/") ||
		strings.HasPrefix(mimeType, "audio/") {
		return true
	}
	switch mimeType {
	case "text/plain", "text/markdown", "text/csv",
		"application/pdf", "application/json", "application/xml":
		return true
	}
	return false
}

// clientIP 从 RemoteAddr 提取客户端 IP（登录限流用）。
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// objectKey 对象键规则：单文件 = objects/{fileID}/{原始名}。
func objectKey(fileID, name string) string {
	return fmt.Sprintf("objects/%s/%s", fileID, name)
}

// quotedETag 生成带引号的 ETag 值（HTTP 规范要求）。
func quotedETag(etag string) string {
	if etag == "" {
		return ""
	}
	etag = strings.Trim(etag, `"`)
	return `"` + etag + `"`
}

// etagEqual 弱比较 If-Range 与当前 ETag（去引号、忽略大小写）。
func etagEqual(a, b string) bool {
	return strings.EqualFold(strings.Trim(a, `"`), strings.Trim(b, `"`))
}
