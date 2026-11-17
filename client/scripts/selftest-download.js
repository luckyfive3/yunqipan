'use strict';
/* 临时自测：native-downloader 功能测试（纯 Node，本地 HTTP 服务器）
 * 覆盖：多线程分块下载完整性、暂停→控制文件→续传、取消清理、无 Range 降级、applySplit 分裂数学。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');

const { NativeDownload } = require(path.join(__dirname, '..', 'electron', 'services', 'native-downloader'));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-dl-test-'));
  const SIZE = 5 * 1024 * 1024;
  const data = crypto.randomBytes(SIZE);
  const sha = crypto.createHash('sha256').update(data).digest('hex');

  let noRange = false;
  let throttle = false; // 测试暂停/取消时启用节流，确保暂停点落在下载中途
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      if (noRange) {
        res.writeHead(200, { 'Content-Length': SIZE, 'Content-Type': 'application/octet-stream' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Length': SIZE, 'Accept-Ranges': 'bytes', ETag: '"t1"', 'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT' });
      res.end();
      return;
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m || noRange) {
      res.writeHead(200, { 'Content-Length': SIZE, 'Content-Type': 'application/octet-stream' });
      res.end(data);
      return;
    }
    let start = m[1] === '' ? 0 : parseInt(m[1], 10);
    let end = m[2] === '' ? SIZE - 1 : Math.min(parseInt(m[2], 10), SIZE - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + SIZE }); res.end(); return; }
    const body = data.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + SIZE,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream'
    });
    if (throttle) {
      // 64KB / 15ms ≈ 4MB/s：给暂停/取消留出反应窗口
      let i = 0;
      const step = () => {
        if (i >= body.length) { res.end(); return; }
        const piece = body.subarray(i, i + 65536);
        i += 65536;
        const next = () => setTimeout(step, 15);
        if (res.write(piece)) next();
        else res.once('drain', next);
      };
      step();
    } else {
      res.end(body);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port + '/f.bin';

  const hashOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  // ---- 测试 1：正常多线程下载 ----
  {
    const dest = path.join(tmp, 't1.bin');
    const dl = new NativeDownload({ url: base, headers: {}, destPath: dest, threads: 4 });
    await new Promise((resolve, reject) => {
      dl.start({
        onProgress: () => {},
        onDone: resolve,
        onError: reject,
        onPaused: () => {},
        onCanceled: () => {}
      });
    });
    assert.strictEqual(hashOf(dest), sha, '多线程下载内容应一致');
    assert.ok(!fs.existsSync(dest + '.wpdl.json'), '完成后控制文件应删除');
    assert.ok(!fs.existsSync(dest + '.part'), '完成后 .part 应归位');
    console.log('[OK] 多线程分块下载（4 线程，完整性校验通过，控制文件清理）');
  }

  // ---- 测试 2：暂停 → 续传（新实例读控制文件）----
  {
    throttle = true;
    const dest = path.join(tmp, 't2.bin');
    const pauseAt = Math.floor(SIZE * 0.35);
    let paused = false;
    const dl = new NativeDownload({ url: base, headers: {}, destPath: dest, threads: 3 });
    await new Promise((resolve, reject) => {
      dl.start({
        onProgress: (total) => {
          if (!paused && total >= pauseAt) {
            paused = true;
            setTimeout(() => dl.pause(), 30); // 异步暂停，避免回调内重入
          }
        },
        onDone: () => reject(new Error('不应直接完成')),
        onError: reject,
        onPaused: resolve,
        onCanceled: () => reject(new Error('不应取消'))
      });
    });
    assert.ok(fs.existsSync(dest + '.wpdl.json'), '暂停后控制文件应存在');
    const ctrl = JSON.parse(fs.readFileSync(dest + '.wpdl.json', 'utf8'));
    assert.ok(ctrl.chunks.length > 1, '控制文件应含多块');
    assert.ok(ctrl.chunks.some((c) => c.start > 0), '应有块 start 已推进（块内断点）');
    // 续传
    const dl2 = new NativeDownload({ url: base, headers: {}, destPath: dest, threads: 3, baseDone: paused ? 1 : 0 });
    await new Promise((resolve, reject) => {
      dl2.start({
        onProgress: () => {},
        onDone: resolve,
        onError: reject,
        onPaused: () => {},
        onCanceled: () => reject(new Error('不应取消'))
      });
    });
    assert.strictEqual(hashOf(dest), sha, '续传后内容应一致');
    console.log('[OK] 暂停（块内断点控制文件）→ 新实例续传完成');
  }

  // ---- 测试 3：取消清理 ----
  {
    throttle = true;
    const dest = path.join(tmp, 't3.bin');
    const dl = new NativeDownload({ url: base, headers: {}, destPath: dest, threads: 2 });
    await new Promise((resolve, reject) => {
      dl.start({
        onProgress: (total) => { if (total >= SIZE * 0.2) { setTimeout(() => dl.cancel(), 20); } },
        onDone: () => reject(new Error('不应完成')),
        onError: reject,
        onPaused: () => {},
        onCanceled: resolve
      });
    });
    assert.ok(!fs.existsSync(dest + '.wpdl.json'), '取消后控制文件应删除');
    assert.ok(!fs.existsSync(dest + '.part'), '取消后 .part 应删除');
    console.log('[OK] 取消：中止线程并清理 .part 与控制文件');
  }

  // ---- 测试 4：无 Range 降级为单线程顺序 ----
  {
    throttle = false;
    noRange = true;
    const dest = path.join(tmp, 't4.bin');
    const dl = new NativeDownload({ url: base, headers: {}, destPath: dest, threads: 8 });
    await new Promise((resolve, reject) => {
      dl.start({
        onProgress: () => {},
        onDone: resolve,
        onError: reject,
        onPaused: () => {},
        onCanceled: () => {}
      });
    });
    assert.strictEqual(hashOf(dest), sha, '降级顺序下载内容应一致');
    noRange = false;
    console.log('[OK] 不支持 Range 时降级单线程顺序下载');
  }

  // ---- 测试 5：applySplit 分裂数学 ----
  {
    const dest = path.join(tmp, 't5.bin');
    const dl = new NativeDownload({ url: base, headers: {}, destPath: dest, threads: 4 });
    // 模拟：块 [0,999] 已写 600 字节（done=600），分裂点 mid=550
    const chunk = { start: 0, end: 999, done: 600, splits: 1 };
    dl.chunks = [chunk];
    dl.splitRequests.set(chunk, { mid: 550, oldEnd: 999 });
    await dl.applySplit(chunk);
    assert.strictEqual(chunk.end, 549, '原块 end 应收缩到 mid-1');
    assert.ok(chunk.start > chunk.end, '原块已写满其区间应标记完成');
    const newChunk = dl.chunks.find((c) => c !== chunk);
    assert.ok(newChunk, '应生成新块');
    assert.strictEqual(newChunk.start, 600, '新块 start 应推进已写偏移（550+surplus50）');
    assert.strictEqual(newChunk.end, 999, '新块 end 应为原块旧 end');
    assert.ok(dl.pending.includes(newChunk), '新块应进入待下队列');
    console.log('[OK] 动态分裂数学：剩余区间一分为二 + 已写字节精确让渡');
  }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('下载内核功能测试全部通过');
})().catch((e) => { console.error('下载内核自测失败：', e); process.exit(1); });
