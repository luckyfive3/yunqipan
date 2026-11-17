'use strict';
/* 临时自测：upload-manager 契约级测试（本地 HTTP 服务器模拟服务端分块上传接口）
 * 覆盖：init→逐块 PUT→complete（流式 sha256）、暂停（块边界）→恢复（received 续传）、
 *       E2E 加密上传（密文大小/加密标记/解密回环）。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');

const { createUploadManager } = require(path.join(__dirname, '..', 'electron', 'services', 'upload-manager'));
const { decryptFile } = require(path.join(__dirname, '..', 'electron', 'services', 'crypto'));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-up-test-'));
  const userDataDir = tmp;

  // ---- 模拟服务端 ----
  const state = { uploads: new Map() }; // upload_id -> {chunks: Map, meta}
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url;
      const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {});
      try {
        if (req.method === 'POST' && url === '/api/v1/files/upload/init') {
          const d = json();
          const id = 'up-' + Math.random().toString(36).slice(2);
          state.uploads.set(id, { chunks: new Map(), meta: d, chunkSize: d.chunk_size });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ upload_id: id, chunk_size: d.chunk_size, received: [] }));
          return;
        }
        const mChunk = /^\/api\/v1\/files\/upload\/([^/]+)\/chunk\/(\d+)$/.exec(url);
        if (req.method === 'PUT' && mChunk) {
          const [, id, idx] = mChunk;
          const up = state.uploads.get(id);
          if (!up) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'UPLOAD_NOT_FOUND', message: '不存在' } })); return; }
          if (up.chunkSize && body.length > up.chunkSize) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'CHUNK_TOO_LARGE', message: '过大' } })); return; }
          up.chunks.set(parseInt(idx, 10), body);
          // 模拟慢网络：让暂停测试有时间停在块边界
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, received: [...up.chunks.keys()] }));
          }, 300);
          return;
        }
        const mGet = /^\/api\/v1\/uploads\/([^/]+)$/.exec(url);
        if (req.method === 'GET' && mGet) {
          const up = state.uploads.get(mGet[1]);
          if (!up) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'UPLOAD_NOT_FOUND', message: '不存在' } })); return; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            upload_id: mGet[1], chunk_size: up.chunkSize, received: [...up.chunks.keys()],
            name: up.meta.name, size: up.meta.size, parent_id: up.meta.parent_id, encrypted: up.meta.encrypted
          }));
          return;
        }
        const mComplete = /^\/api\/v1\/files\/upload\/([^/]+)\/complete$/.exec(url);
        if (req.method === 'POST' && mComplete) {
          const up = state.uploads.get(mComplete[1]);
          if (!up) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'UPLOAD_NOT_FOUND', message: '不存在' } })); return; }
          const d = json();
          const all = Buffer.concat([...up.chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
          if (d.sha256) {
            const got = crypto.createHash('sha256').update(all).digest('hex');
            if (got !== d.sha256) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'sha256 不匹配' } })); return; }
          }
          state.uploads.set(mComplete[1], Object.assign({}, up, { done: all }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ file: { id: 'file-' + mComplete[1], name: up.meta.name, size: up.meta.size } }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '未实现 ' + req.method + ' ' + url } }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: String(e) } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  // ---- api 桩（按 upload-manager 需要的接口实现）----
  const api = {
    get: async (p) => fetchJSON('GET', base + p),
    post: async (p, b) => fetchJSON('POST', base + p, b),
    put: async (p, buf, o) => {
      // 与真实 api-client 一致：透传 AbortSignal，暂停才能中止在途块请求
      const res = await fetch(base + p, {
        method: 'PUT',
        headers: (o && o.headers) || {},
        body: buf,
        signal: (o && o.signal) || undefined
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        const err = new Error((e.error && e.error.message) || ('HTTP ' + res.status));
        err.code = (e.error && e.error.code) || ('HTTP_' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    del: async () => ({ ok: true })
  };
  async function fetchJSON(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data.error && data.error.message) || ('HTTP ' + res.status));
      err.code = (data.error && data.error.code) || ('HTTP_' + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const settings = {
    get: (k) => ({
      uploadChunkSize: 5 * 1024 * 1024,
      e2ePassphrase: '测试口令',
      e2eDefault: false
    }[k])
  };
  const queue = { updateTask: () => {} };
  const um = createUploadManager({ settings, api, queue, userDataDir });

  // ---- 测试 1：普通分块上传（含暂停→恢复）----
  {
    const local = path.join(tmp, 'plain.bin');
    const data = crypto.randomBytes(6 * 1024 * 1024 + 34567);
    fs.writeFileSync(local, data);
    const sha = crypto.createHash('sha256').update(data).digest('hex');

    const def = await um.createTask({ localPath: local, parentId: null });
    const task = { id: 't-plain', uploadId: null, encrypted: false, name: def.name, size: def.size, source: def.source, destPath: def.destPath };

    let pausedAt = null;
    let done = false, err = null;
    await new Promise((resolve) => {
      um.start(task, {
        onProgress: (total) => {
          if (!pausedAt && total >= def.size * 0.4) {
            pausedAt = total;
            setTimeout(() => um.pause(task), 10); // 块边界暂停
          }
        },
        onDone: () => { done = true; resolve(); },
        onError: (e) => { err = e; resolve(); },
        onPaused: resolve,
        onCanceled: () => resolve()
      });
    });
    assert.ok(!done && !err, '暂停时应停在 onPaused 而非完成/失败');
    assert.ok(task.uploadId, '暂停后应已持久化 upload_id');
    const up = [...state.uploads.values()][0];
    assert.ok(up.chunks.size >= 1 && up.chunks.size <= Math.ceil(def.size / (5 * 1024 * 1024)), '暂停时服务端已收块数合理：' + up.chunks.size);

    // 恢复：新 start() 读取 GET /upload/{id}，跳过 received
    let doneResult = null;
    await new Promise((resolve, reject) => {
      um.start(task, {
        onProgress: () => {},
        onDone: (r) => { done = true; doneResult = r; resolve(); },
        onError: reject,
        onPaused: () => reject(new Error('不应暂停')),
        onCanceled: () => reject(new Error('不应取消'))
      });
    });
    assert.ok(done, '恢复后应完成');
    const final = state.uploads.get(task.uploadId).done;
    assert.ok(final.equals(data), '服务端拼接数据应与原文一致');
    // 生产路径由 transfer-queue.finish 将 result.fileId 写入 task.fileId；此处验证管理器透传
    assert.ok(doneResult && doneResult.fileId === 'file-' + task.uploadId, '完成事件应带回 fileId');
    console.log('[OK] 分块上传：init→PUT×N→complete（sha256 校验通过），暂停（块边界）→恢复（received 续传）');
  }

  // ---- 测试 2：E2E 加密上传 ----
  {
    const local = path.join(tmp, 'secret.bin');
    const data = crypto.randomBytes(1024 * 1024 + 777);
    fs.writeFileSync(local, data);

    const def = await um.createTask({ localPath: local, parentId: null, encrypted: true });
    const task = { id: 't-enc', uploadId: null, encrypted: true, name: def.name, size: def.size, source: def.source, destPath: def.destPath };
    await new Promise((resolve, reject) => {
      um.start(task, {
        onProgress: () => {},
        onDone: resolve,
        onError: reject,
        onPaused: () => reject(new Error('不应暂停')),
        onCanceled: () => reject(new Error('不应取消'))
      });
    });
    const up = state.uploads.get(task.uploadId);
    assert.strictEqual(up.meta.encrypted, true, 'init 应标记 encrypted=true');
    assert.ok(up.meta.size > def.size, '密文大小应大于明文（含块头/IV/tag 开销）');
    const dec = path.join(tmp, 'secret-dec.bin');
    fs.writeFileSync(path.join(tmp, 'secret-enc-dump.bin'), up.done);
    await decryptFile(path.join(tmp, 'secret-enc-dump.bin'), dec, '测试口令');
    assert.ok(fs.readFileSync(dec).equals(data), '解密回环应与原文一致');
    console.log('[OK] E2E：先加密临时文件再上传（encrypted 标记 + 密文大小 + 解密回环）');
  }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('上传管理器契约测试全部通过');
})().catch((e) => { console.error('上传自测失败：', e); process.exit(1); });
