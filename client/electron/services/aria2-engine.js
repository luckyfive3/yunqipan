'use strict';
/**
 * aria2-engine.js —— 可选 aria2 加速内核
 *
 * 职责：
 *   1. spawn aria2c（settings.aria2Path 指定路径，否则 PATH 中的 aria2c），开启 RPC：
 *      --enable-rpc --rpc-secret=wpdrive --rpc-listen-port=<随机空闲端口> --dir=<cacheDir/aria2>
 *      --continue=true --auto-file-renaming=false --allow-overwrite=true --file-allocation=none
 *      --max-concurrent-downloads=<maxDownloadTasks> --max-connection-per-server=16
 *      --split=<defaultThreads> --min-split-size=1M --console-log-level=error
 *   2. 经 http://127.0.0.1:<port>/jsonrpc POST 调用：
 *      aria2.addUri（params:[[url],{out, header, split, min-split-size, max-connection-per-server, dir}]，
 *      按 aria2 JSON-RPC 协议 secret 必须放在 params 首位，即 ["token:wpdrive", ...]）、
 *      aria2.tellStatus（1s 轮询）、aria2.pause/unpause/remove/removeDownloadResult、
 *      aria2.changeGlobalOption({max-overall-download-limit}) 限速（字节/秒）。
 *   3. aria2 控制文件（.aria2）落在 cacheDir/aria2，天然支持重启续传；
 *      退出时优先发 aria2.shutdown 优雅落盘，超时再 SIGTERM。
 *   4. 二进制不存在或启动失败 → available() 返回 false，下载引擎自动回退自研内核，
 *      私有云盘功能完全不受影响。
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { net: enet } = require('electron');

const SECRET = 'token:wpdrive';

function createAria2Engine({ settings, userDataDir }) {
  let child = null;
  let port = 0;
  let broken = false;
  let triedOnce = false;
  let pollTimer = null;
  const jobs = new Map(); // gid -> {gid, taskId, destPath, out, handlers}
  const cacheDir = path.join(userDataDir, 'cache', 'aria2');

  function sanitizeName(n) {
    return String(n || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-80);
  }

  async function freePort() {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.unref();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
  }

  /** 引擎是否可尝试使用：被标记 broken 后本次会话不再尝试。 */
  function available() {
    if (broken) return false;
    if (!settings.get('aria2Enabled')) return false;
    if (child && child.exitCode === null) return true;
    if (triedOnce && !child) return false;
    return true;
  }

  async function rpcRaw(method, params) {
    if (!port) throw { code: 'ARIA2_UNAVAILABLE', message: 'aria2 未启动' };
    const body = {
      jsonrpc: '2.0',
      id: String(Math.random()),
      method,
      params: [SECRET, ...params] // aria2 协议要求 secret 为 params 首元素
    };
    const res = await enet.fetch('http://127.0.0.1:' + port + '/jsonrpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data && data.error) {
      throw { code: 'ARIA2_RPC', message: 'aria2 RPC 错误：' + (data.error.message || data.error.code) };
    }
    return data.result;
  }

  async function ensureRunning() {
    if (child && child.exitCode === null) return;
    if (broken) throw { code: 'ARIA2_UNAVAILABLE', message: 'aria2 不可用（已回退自研内核）' };
    triedOnce = true;
    await fsp.mkdir(cacheDir, { recursive: true });
    port = await freePort();
    const args = [
      '--enable-rpc',
      '--rpc-secret=wpdrive',
      '--rpc-listen-port=' + port,
      '--dir=' + cacheDir,
      '--continue=true',
      '--auto-file-renaming=false',
      '--allow-overwrite=true',
      '--file-allocation=none',
      '--max-concurrent-downloads=' + (settings.get('maxDownloadTasks') || 3),
      '--max-connection-per-server=16',
      '--split=' + (settings.get('defaultThreads') || 8),
      '--min-split-size=1M',
      '--console-log-level=error',
      '--check-certificate=false'
    ];
    await new Promise((resolve, reject) => {
      let settled = false;
      let c;
      try {
        c = spawn(settings.get('aria2Path') || 'aria2c', args, {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true
        });
      } catch (e) {
        broken = true;
        reject({ code: 'ARIA2_UNAVAILABLE', message: 'aria2 启动失败：' + e.message });
        return;
      }
      child = c;
      if (c.stderr) c.stderr.on('data', () => {});
      c.on('error', (e) => {
        if (!settled) {
          settled = true;
          broken = true;
          child = null;
          reject({
            code: 'ARIA2_UNAVAILABLE',
            message: 'aria2 启动失败：' +
              (e.code === 'ENOENT' ? '未找到 aria2c 可执行文件（请安装或到设置中指定路径）' : e.message)
          });
        }
      });
      c.on('exit', () => {
        child = null;
        port = 0;
        for (const job of jobs.values()) {
          if (job.handlers) job.handlers.onError({ code: 'ARIA2_EXITED', message: 'aria2 进程意外退出（可重试）' });
        }
        jobs.clear();
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      });
      const t0 = Date.now();
      const tick = async () => {
        if (settled) return;
        try {
          await rpcRaw('aria2.getVersion', []);
          settled = true;
          applyLimit().catch(() => {});
          resolve();
        } catch (e) {
          if (Date.now() - t0 > 3000) {
            settled = true;
            try { c.kill('SIGTERM'); } catch (_) {}
            broken = true;
            child = null;
            reject({ code: 'ARIA2_UNAVAILABLE', message: 'aria2 启动超时或启动失败' });
          } else {
            setTimeout(tick, 200);
          }
        }
      };
      tick();
    });
  }

  /** addUri：向 aria2 投递下载。返回 gid。 */
  async function add({ taskId, url, headers, destPath, threads, handlers }) {
    await ensureRunning();
    const out = taskId + '-' + sanitizeName(path.basename(destPath));
    const opts = {
      out,
      dir: cacheDir,
      'continue': 'true',
      'auto-file-renaming': 'false',
      'allow-overwrite': 'true',
      'file-allocation': 'none',
      'split': String(threads || settings.get('defaultThreads') || 8),
      'min-split-size': '1M',
      'max-connection-per-server': '16',
      'header': Object.entries(headers || {}).map(([k, v]) => k + ': ' + v)
    };
    const gid = await rpcRaw('aria2.addUri', [[url], opts]);
    jobs.set(gid, { gid, taskId, destPath, out, handlers });
    startPoll();
    return gid;
  }

  function has(gid) { return jobs.has(gid); }

  /** 刷新任务事件回调（队列重新调度任务时使用）。 */
  function updateHandlers(gid, handlers) {
    const job = jobs.get(gid);
    if (job) job.handlers = handlers;
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, 1000);
  }

  async function poll() {
    for (const job of [...jobs.values()]) {
      try {
        const st = await rpcRaw('aria2.tellStatus', [job.gid,
          ['status', 'completedLength', 'totalLength', 'downloadSpeed', 'errorCode', 'errorMessage']]);
        if (st.status === 'active' || st.status === 'waiting') {
          job.handlers.onProgress(parseInt(st.completedLength, 10) || 0);
        } else if (st.status === 'complete') {
          jobs.delete(job.gid);
          await finalize(job);
        } else if (st.status === 'error') {
          jobs.delete(job.gid);
          job.handlers.onError({
            code: 'ARIA2_ERROR',
            message: 'aria2 下载失败：' + (st.errorMessage || ('错误码 ' + st.errorCode))
          });
        } else if (st.status === 'paused') {
          // 用户主动暂停时 errorCode 为 0；非 0 说明是出错后挂起
          if (st.errorCode && String(st.errorCode) !== '0') {
            jobs.delete(job.gid);
            job.handlers.onError({
              code: 'ARIA2_ERROR',
              message: 'aria2 下载失败：' + (st.errorMessage || ('错误码 ' + st.errorCode))
            });
          }
        } else if (st.status === 'removed') {
          jobs.delete(job.gid);
          job.handlers.onCanceled();
        }
      } catch (e) {
        if (/not found|unknown gid|已移除/i.test(String(e.message))) {
          jobs.delete(job.gid);
          job.handlers.onError({ code: 'ARIA2_LOST', message: 'aria2 任务丢失（可重试续传）' });
        }
      }
    }
    if (jobs.size === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /** 完成后把 cacheDir 里的文件归位到 destPath，并清理 aria2 记录。 */
  async function finalize(job) {
    try {
      const from = path.join(cacheDir, job.out);
      await fsp.mkdir(path.dirname(job.destPath), { recursive: true });
      try {
        await fsp.rename(from, job.destPath);
      } catch (e) {
        await fsp.copyFile(from, job.destPath);
        await fsp.unlink(from).catch(() => {});
      }
      await rpcRaw('aria2.removeDownloadResult', [job.gid]).catch(() => {});
      job.handlers.onDone();
    } catch (e) {
      job.handlers.onError({ code: 'ARIA2_MOVE', message: '文件归位失败：' + e.message });
    }
  }

  async function pause(gid) { await rpcRaw('aria2.pause', [gid]).catch(() => {}); }
  async function unpause(gid) { await rpcRaw('aria2.unpause', [gid]).catch(() => {}); }

  async function cancel(gid) {
    const job = jobs.get(gid);
    await rpcRaw('aria2.remove', [gid]).catch(() => {});
    await rpcRaw('aria2.removeDownloadResult', [gid]).catch(() => {});
    jobs.delete(gid);
    if (jobs.size === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (job && job.handlers) job.handlers.onCanceled();
  }

  /** 全局限速（字节/秒；0 = 不限）。 */
  async function applyLimit() {
    if (!port || !child || child.exitCode !== null) return;
    const kbps = settings.get('limitDownKbps') || 0;
    await rpcRaw('aria2.changeGlobalOption', [{
      'max-overall-download-limit': String(kbps * 1024)
    }]).catch(() => {});
  }

  /** 本次会话标记不可用（下载引擎收到后回退自研内核）。 */
  function markBroken() { broken = true; }

  /** 退出：优先 aria2.shutdown 优雅落盘，超时 SIGTERM。 */
  async function shutdown() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (child && child.exitCode === null) {
      try {
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          (async () => {
            await rpcRaw('aria2.shutdown', []).catch(() => {});
            await new Promise((r) => setTimeout(r, 1500));
          })()
        ]);
      } catch (e) { /* 继续 SIGTERM */ }
      try { child.kill('SIGTERM'); } catch (e) { /* 已退出 */ }
    }
    jobs.clear();
  }

  return {
    available, add, has, updateHandlers, pause, unpause, cancel, applyLimit, markBroken, shutdown,
    isRunning: () => !!child && child.exitCode === null
  };}

module.exports = { createAria2Engine };
