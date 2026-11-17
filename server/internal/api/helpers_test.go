// helpers_test.go —— API 层纯函数单元测试（不依赖任何外部服务）。
package api

import (
	"testing"
)

func TestParseRangeHeader(t *testing.T) {
	cases := []struct {
		name     string
		header   string
		size     int64
		start    int64
		end      int64
		hasRange bool
		wantErr  error
	}{
		{"无 Range 头", "", 100, 0, 0, false, nil},
		{"完整区间", "bytes=0-99", 100, 0, 99, true, nil},
		{"区间截断到文件末尾", "bytes=50-9999", 100, 50, 99, true, nil},
		{"开区间 bytes=50-", "bytes=50-", 100, 50, 99, true, nil},
		{"后缀区间 bytes=-10", "bytes=-10", 100, 90, 99, true, nil},
		{"后缀超过文件大小", "bytes=-999", 100, 0, 99, true, nil},
		{"起始超出范围", "bytes=100-199", 100, 0, 0, true, errRangeUnsatisfiable},
		{"非法单位", "items=0-99", 100, 0, 0, true, errRangeInvalid},
		{"多段 Range 不支持", "bytes=0-1,5-9", 100, 0, 0, true, errRangeInvalid},
		{"start>end", "bytes=90-10", 100, 0, 0, true, errRangeUnsatisfiable},
		{"空文件任何 Range 不满足", "bytes=0-0", 0, 0, 0, true, errRangeUnsatisfiable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			start, end, has, err := parseRangeHeader(newRangeRequest(c.header), c.size)
			if err != c.wantErr {
				t.Fatalf("err = %v, want %v", err, c.wantErr)
			}
			if has != c.hasRange || start != c.start || end != c.end {
				t.Fatalf("got (has=%v start=%d end=%d), want (has=%v start=%d end=%d)",
					has, start, end, c.hasRange, c.start, c.end)
			}
		})
	}
}

func TestValidateFileName(t *testing.T) {
	valid := []string{"a", "report.pdf", "中文 文档.txt", "a.b.c"}
	for _, n := range valid {
		if err := validateFileName(n); err != nil {
			t.Errorf("validateFileName(%q) 应通过，得到: %v", n, err)
		}
	}
	invalid := []string{"", ".", "..", "a/b", `a\b`, "a:b", "a*b", "a?b", `a"b`, "a<b", "a>b", "a|b", "a\tb"}
	for _, n := range invalid {
		if err := validateFileName(n); err == nil {
			t.Errorf("validateFileName(%q) 应拒绝", n)
		}
	}
	long := make([]byte, 256)
	for i := range long {
		long[i] = 'x'
	}
	if err := validateFileName(string(long)); err == nil {
		t.Error("256 字节文件名应拒绝")
	}
}

func TestValidateExtractCode(t *testing.T) {
	for _, c := range []string{"1234", "abcd", "Ab1Cd2", "12345678"} {
		if err := validateExtractCode(c); err != nil {
			t.Errorf("validateExtractCode(%q) 应通过，得到: %v", c, err)
		}
	}
	for _, c := range []string{"", "123", "123456789", "12 4", "12-4", "中文提取码"} {
		if err := validateExtractCode(c); err == nil {
			t.Errorf("validateExtractCode(%q) 应拒绝", c)
		}
	}
}

func TestPreviewMimeAllowed(t *testing.T) {
	allowed := []string{"image/png", "video/mp4", "audio/mpeg", "text/plain",
		"text/markdown", "text/csv", "application/pdf", "application/json", "application/xml"}
	for _, m := range allowed {
		if !previewMimeAllowed(m) {
			t.Errorf("previewMimeAllowed(%q) 应为 true", m)
		}
	}
	denied := []string{"application/octet-stream", "application/zip", "application/x-msdownload", "text/html"}
	for _, m := range denied {
		if previewMimeAllowed(m) {
			t.Errorf("previewMimeAllowed(%q) 应为 false", m)
		}
	}
}

func TestObjectKeyAndETag(t *testing.T) {
	if got := objectKey("file-id-1", "报告.pdf"); got != "objects/file-id-1/报告.pdf" {
		t.Fatalf("objectKey = %q", got)
	}
	if got := quotedETag(`"abc"`); got != `"abc"` {
		t.Fatalf("quotedETag = %q", got)
	}
	if got := quotedETag("abc"); got != `"abc"` {
		t.Fatalf("quotedETag = %q", got)
	}
	if !etagEqual(`"ABC"`, "abc") {
		t.Error("ETag 弱比较应忽略引号与大小写")
	}
	if etagEqual("abc", "abd") {
		t.Error("不同 ETag 不应相等")
	}
}

func TestValidUUID(t *testing.T) {
	if !validUUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8") {
		t.Error("合法 UUID 应通过")
	}
	for _, s := range []string{"", "not-a-uuid", "6ba7b810", "6ba7b810-9dad-11d1-80b4-00c04fd430cg"} {
		if validUUID(s) {
			t.Errorf("validUUID(%q) 应为 false", s)
		}
	}
}
