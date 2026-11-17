'use strict';
/**
 * download-engine.js —— 下载引擎门面（统一入口）
 *
 * 职责：
 *   1. 对传输队列暴露统一的 start/pause/resume/cancel/retry 任务级接口。
 *   2. 按 settings.aria2Enabled 且 aria2 引擎可用选择 aria2 / 自研内核；
 *      aria2 二进制缺失、启动失败或投递失败时自动回退自研内核，私有云盘功能不受影响。
 *   3. 把任务 source 解析为真实下载 URL + 请求头：
 *      - file ：服务端 /api/v1/files/{id}/download?download=1（带 Bearer，支持 Range/206）
 *      - share：公开 /api/v1/shares/{token}/download?node=...&download=1（免 Bearer）
 *      - url  ：直链 + 用户自定义 headers（如 UA/Referer）
 *   4. 【分层说明】aria2 引擎只负责“原始分块取数”（服务器多连接分段，.aria2 控制文件
 *      落在 cacheDir/aria2，重启天然续传）；自研内核负责“线程数 / 块大小 / 慢块分裂”的
 *      动态调度。本门面不关心下层实现细节，对队列暴露的任务级事件
 *      （onProgress/onDone/onError/onPaused/onCanceled）始终一致。
 */
const { NativeDownload } = require('./native-downloader');

function clamp(v, lo, hi) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function createDownloadEngine({ settings, api, aria2Engine }) {
  const handles = new Map(); // taskId -> {kind:'aria2'|'native', gid?, dl?}

  function buildRequest(task) {
    const s = task.source || {};
    const base = api.base();
    if (s.type === 'file') {
      return {
        url: base + '/api/v1/files/' + encodeURIComponent(s.fileId) + '/download?download=1',
        headers: { Authorization: 'Bearer ' + api.getToken() }
      };
    }
    if (s.type === 'share') {
      return {
        url: base + '/api/v1/shares/' + encodeURIComponent(s.token) +
          '/download?node=' + encodeURIComponent(s.nodeId) + '&download=1',
        headers: {}
      };
    }
    if (s.type === 'url') {
      return { url: s.url, headers: s.headers || {} };
    }
    throw { code: 'INVALID_INPUT', message: '未知的下载源类型：' + (s.type || '空') };
  }

  function threadsOf(task) {
    return clamp(task.threads || settings.get('defaultThreads') || 8, 1, settings.get('maxThreadsPerFile') || 32);
  }

  /** 包装任务级事件：终态时清理句柄。 */
  function wrap(task, handlers, keepOnPause) {
    return {
      onProgress: (d) => handlers.onProgress(d),
      onDone: () => { handles.delete(task.id); handlers.onDone(); },
      onError: (e) => {
        handles.delete(task.id);
        // 下载目录不可写（受限环境/权限问题）时给出明确指引
        if (e && /EPERM|EACCES|EBUSY/i.test((e.message || '') + (e.code || ''))) {
          e = Object.assign({}, e, {
            message: (e.message || '') + ' —— 目标位置不可写，请到「设置」把下载目录改到可写位置后重试'
          });
        }
        handlers.onError(e);
      },
      onCanceled: () => { handles.delete(task.id); handlers.onCanceled(); },
      onPaused: () => { if (!keepOnPause) handles.delete(task.id); handlers.onPaused(); }
    };
  }

  async function start(task, handlers) {
    // 恢复场景：aria2 任务被暂停后句柄仍在，直接 unpause 并刷新事件回调即可
    const existing = handles.get(task.id);
    if (existing && existing.kind === 'aria2' && aria2Engine.has(existing.gid)) {
      aria2Engine.updateHandlers(existing.gid, wrap(task, handlers, true));
      aria2Engine.unpause(existing.gid);
      return;
    }
    const req = buildRequest(task);
    const threads = threadsOf(task);
    // 尽力获取文件 sha256（用于完成后流式校验；失败不阻断下载）
    let expectedSha256 = task.expectedSha256 || null;
    if (task.source.type === 'file' && !task.expectedSha256) {
      try {
        const d = await api.get('/api/v1/files/' + encodeURIComponent(task.source.fileId));
        if (d && d.file && d.file.sha256) expectedSha256 = d.file.sha256;
      } catch (e) { /* 忽略 */ }
    }
    const wrapped = wrap(task, handlers, false);
    if (settings.get('aria2Enabled') && aria2Engine.available()) {
      try {
        const gid = await aria2Engine.add({
          taskId: task.id, url: req.url, headers: req.headers,
          destPath: task.destPath, threads, handlers: wrap(task, handlers, true)
        });
        handles.set(task.id, { kind: 'aria2', gid });
        return;
      } catch (e) {
        aria2Engine.markBroken(); // 自动回退自研内核
      }
    }
    const dl = new NativeDownload({
      url: req.url,
      headers: req.headers,
      destPath: task.destPath,
      threads,
      expectedSha256,
      baseDone: task.done || 0
    });
    handles.set(task.id, { kind: 'native', dl });
    dl.start(wrapped);
  }

  function pause(task) {
    const h = handles.get(task.id);
    if (!h) return;
    if (h.kind === 'aria2') aria2Engine.pause(h.gid);
    else h.dl.pause();
  }

  function resume(task) {
    const h = handles.get(task.id);
    if (!h) return;
    if (h.kind === 'aria2' && aria2Engine.has(h.gid)) {
      aria2Engine.unpause(h.gid);
      return;
    }
    // native：新实例读取 .wpdl.json 控制文件精确续传（含块内偏移）
    const req = buildRequest(task);
    const dl = new NativeDownload({
      url: req.url,
      headers: req.headers,
      destPath: task.destPath,
      threads: threadsOf(task),
      expectedSha256: task.expectedSha256 || null,
      baseDone: task.done || 0
    });
    handles.set(task.id, { kind: 'native', dl });
    dl.start({
      onProgress: (d) => { /* 进度经队列心跳与持久化事件推送 */ },
      onDone: () => { handles.delete(task.id); },
      onError: () => { handles.delete(task.id); },
      onCanceled: () => { handles.delete(task.id); },
      onPaused: () => { handles.delete(task.id); }
    });
  }

  function cancel(task) {
    const h = handles.get(task.id);
    if (!h) {
      // 已暂停/出错的任务没有活动句柄（自研内核暂停后即释放实例）：
      // 取消时需要手动清理 .part 与控制文件
      const dl = new NativeDownload({ url: 'http://invalid.local/', headers: {}, destPath: task.destPath });
      dl.cleanupFiles().catch(() => {});
      return;
    }
    if (h.kind === 'aria2') aria2Engine.cancel(h.gid);
    else h.dl.cancel();
  }

  return { start, pause, resume, cancel, retry: start };
}

module.exports = { createDownloadEngine };
