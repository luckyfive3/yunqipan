'use strict';
/**
 * upload-manager.js —— 分块上传管理器
 *
 * 职责：
 *   1. 严格按服务端契约实现分块上传：
 *      POST /files/upload/init（chunk_size 默认 8MiB，settings.uploadChunkSize 5~64MiB 可调；
 *      S3 要求除最后一块外每块 ≥5MiB，故下限为 5MiB）
 *      → 跳过 received 已完成分块 → 逐块 PUT /files/upload/{id}/chunk/{index}
 *        （fetch，Body 为 Uint8Array；网络/5xx 重试 3 次指数退避 0.5/1/2s；4xx 立即中止）
 *      → POST /files/upload/{id}/complete（带流式 sha256）→ 完成事件。
 *   2. 暂停在块边界（AbortController 中止在途块请求）；取消时中止会话（DELETE upload 会话）
 *      并清理加密临时文件；恢复/重启后通过任务持久化的 upload_id 调
 *      GET /files/upload/{upload_id} 恢复现场（received 列表）继续传。
 *   3. E2E：先经 crypto.encryptFile 把本地文件加密到 cacheDir/enc-tmp 临时文件，
 *      上传密文并在 init 标记 encrypted=true；加密文件不参与服务端预览。
 *   4. 进度/速度事件经队列回调上报（绝对字节数，含跳过块）。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { encryptFile } = require('./crypto');

const MI1 = 1024 * 1024;
const RETRY_BACKOFF = [500, 1000, 2000];

const MIME_MAP = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
  pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

function inferMime(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function createUploadManager({ settings, api, queue, userDataDir }) {
  const sessions = new Map(); // taskId -> {paused, canceled, controller, fd}
  const encTmpDir = path.join(userDataDir, 'cache', 'enc-tmp');

  /** 从本地路径构建上传任务定义（不直接入队，交由传输队列持久化调度）。 */
  async function createTask({ localPath, parentId, name, encrypted }) {
    let st;
    try { st = await fsp.stat(localPath); } catch (e) {
      throw { code: 'FILE_NOT_FOUND', message: '本地文件不存在：' + localPath };
    }
    return {
      kind: 'upload',
      name: name || path.basename(localPath),
      size: st.size,
      source: { type: 'local', localPath, parentId: parentId ?? null, mime: inferMime(localPath) },
      destPath: localPath,
      encrypted: !!encrypted
    };
  }

  async function ensureEncrypted(task) {
    await fsp.mkdir(encTmpDir, { recursive: true });
    const tmp = path.join(encTmpDir, task.id + '.wpenc');
    try { await fsp.stat(tmp); return tmp; } catch (e) { /* 首次加密 */ }
    const pass = settings.get('e2ePassphrase') || 'yunqipan';
    await encryptFile(task.source.localPath, tmp, pass, null);
    return tmp;
  }

  async function start(task, handlers) {
    const rec = sessions.get(task.id) || { paused: false, canceled: false, controller: null };
    rec.paused = false;
    rec.canceled = false;
    rec.active = true;
    sessions.set(task.id, rec);
    let fd = null;
    try {
      // E2E：先加密到临时文件，上传密文
      let upPath = task.source.localPath;
      if (task.encrypted) upPath = await ensureEncrypted(task);

      const st = await fsp.stat(upPath);
      if (st.size !== task.size) {
        task.size = st.size;
        queue.updateTask(task);
      }
      let chunkSize = Math.min(64 * MI1, Math.max(5 * MI1, settings.get('uploadChunkSize') || 8 * MI1));
      const totalChunks = () => Math.max(1, Math.ceil(task.size / chunkSize));
      const chunkLen = (i) => Math.min(chunkSize, task.size - i * chunkSize);

      // 恢复现场：有 upload_id 就 GET 会话拿到 received（含重启后）；404 则重新 init
      let received = [];
      if (task.uploadId) {
        try {
          const info = await api.get('/api/v1/uploads/' + encodeURIComponent(task.uploadId));
          if (info && info.upload_id) {
            received = info.received || [];
            // 服务端记录的 chunk_size 为准（设置可能中途修改过）
            if (info.chunk_size && info.chunk_size >= MI1 && info.chunk_size <= 64 * MI1) {
              chunkSize = info.chunk_size;
            }
          }
        } catch (e) {
          if (e.status === 404 || e.code === 'UPLOAD_NOT_FOUND') task.uploadId = null;
          else throw e;
        }
      }
      if (!task.uploadId) {
        const init = await api.post('/api/v1/files/upload/init', {
          parent_id: task.source.parentId ?? null,
          name: task.name,
          size: task.size,
          mime: task.source.mime || inferMime(task.name),
          encrypted: !!task.encrypted,
          chunk_size: chunkSize
        });
        task.uploadId = init.upload_id;
        received = init.received || [];
        queue.updateTask(task);
      }

      fd = await fsp.open(upPath, 'r');
      rec.fd = fd;
      const receivedSet = new Set((received || []).map((n) => parseInt(n, 10)));
      const hash = crypto.createHash('sha256');
      let hashComplete = true;
      let base = 0;
      // 跳过块计入进度基数
      for (const i of receivedSet) base += chunkLen(i);

      for (let i = 0; i < totalChunks(); i++) {
        if (receivedSet.has(i)) { hashComplete = false; continue; } // 续传跳过 → sha256 留空
        if (rec.paused || rec.canceled) return abort(task, handlers);
        const len = chunkLen(i);
        const buf = Buffer.allocUnsafe(len);
        let off = 0;
        while (off < len) {
          const { bytesRead } = await fd.read(buf, off, len - off, i * chunkSize + off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        if (off < len) throw { code: 'FILE_CHANGED', message: '本地文件在读取过程中发生变化' };
        hash.update(buf);
        await putChunkWithRetry(task, i, buf, rec);
        base += len;
        handlers.onProgress(base);
      }
      const completeBody = hashComplete ? { sha256: hash.digest('hex') } : {};
      const complete = await api.post('/api/v1/files/upload/' + encodeURIComponent(task.uploadId) + '/complete', completeBody);
      cleanupTemp(task);
      rec.active = false;
      sessions.delete(task.id);
      handlers.onDone({ fileId: complete && complete.file ? complete.file.id : null });
    } catch (e) {
      if (rec.paused || rec.canceled) return abort(task, handlers);
      // 会话失效（服务端重启/缓存丢失）→ 清掉 upload_id 整体重来一次（自动恢复）
      if ((e.code === 'SESSION_LOST' || e.code === 'UPLOAD_NOT_FOUND') && !rec.restarted) {
        rec.restarted = true;
        rec.active = false;
        task.uploadId = null;
        queue.updateTask(task);
        return start(task, handlers);
      }
      rec.active = false;
      sessions.delete(task.id);
      if (e.status >= 400 && e.status < 500) {
        // 服务端明确拒绝：中止会话不再续传
        if (task.uploadId) api.del('/api/v1/files/upload/' + encodeURIComponent(task.uploadId)).catch(() => {});
      }
      handlers.onError({ code: e.code || 'UPLOAD_FAILED', message: e.message || '上传失败' });
    } finally {
      if (fd) await fd.close().catch(() => {});
      rec.fd = null;
    }
  }

  /** 单块 PUT：重试 3 次指数退避（0.5/1/2s）；4xx 立即抛出中止。 */
  async function putChunkWithRetry(task, index, buf, rec) {
    const url = '/api/v1/files/upload/' + encodeURIComponent(task.uploadId) + '/chunk/' + index;
    let lastErr = null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const ctl = new AbortController();
      rec.controller = ctl;
      try {
        await api.put(url, buf, {
          headers: { 'Content-Type': 'application/octet-stream' },
          timeoutMs: 120000,
          signal: ctl.signal // 暂停/取消时立即中止在途块请求
        });
        rec.controller = null;
        return;
      } catch (e) {
        rec.controller = null;
        if (rec.paused || rec.canceled) {
          const pe = new Error('已暂停'); pe.code = 'PAUSED';
          throw pe;
        }
        if (e.status >= 400 && e.status < 500) {
          // 会话失效类 404：转为 SESSION_LOST 让外层自动重建会话重来
          if (e.code === 'UPLOAD_NOT_FOUND' || e.status === 404) {
            const se = new Error('上传会话已失效');
            se.code = 'SESSION_LOST';
            throw se;
          }
          throw e; // 其余 4xx：块过大等，立即中止
        }
        lastErr = e;
        if (attempt < 3) {
          const end = Date.now() + RETRY_BACKOFF[attempt];
          while (Date.now() < end) {
            if (rec.paused || rec.canceled) {
              const pe = new Error('已暂停'); pe.code = 'PAUSED';
              throw pe;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      }
    }
    throw lastErr || { code: 'UPLOAD_FAILED', message: '分块上传失败' };
  }

  function abort(task, handlers) {
    const rec = sessions.get(task.id);
    if (rec) {
      rec.active = false;
      if (rec.canceled) {
        if (task.uploadId) {
          api.del('/api/v1/files/upload/' + encodeURIComponent(task.uploadId)).catch(() => {});
        }
        cleanupTemp(task);
        sessions.delete(task.id);
        handlers.onCanceled();
        return;
      }
      sessions.delete(task.id);
      handlers.onPaused();
    }
  }

  function pause(task) {
    const rec = sessions.get(task.id);
    if (rec) {
      rec.paused = true;
      if (rec.controller) rec.controller.abort();
    }
  }

  function cancel(task) {
    const rec = sessions.get(task.id);
    if (!rec || !rec.active) {
      // 任务未在传输中（已暂停/出错）：直接清理上传会话与加密临时文件
      if (task.uploadId) {
        api.del('/api/v1/files/upload/' + encodeURIComponent(task.uploadId)).catch(() => {});
      }
      cleanupTemp(task);
      sessions.delete(task.id);
      return;
    }
    rec.canceled = true;
    rec.paused = false;
    if (rec.controller) rec.controller.abort();
  }

  function cleanupTemp(task) {
    if (!task.encrypted) return;
    fsp.unlink(path.join(encTmpDir, task.id + '.wpenc')).catch(() => {});
  }

  return { createTask, start, pause, cancel, cleanupTemp };
}

module.exports = { createUploadManager, inferMime };
