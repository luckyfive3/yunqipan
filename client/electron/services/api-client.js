'use strict';
/**
 * api-client.js —— 服务端 HTTP 客户端
 *
 * 职责：
 *   1. 基于 Electron 主进程 net.fetch 封装对服务端的请求，自动附带
 *      Authorization: Bearer <token>（token 持久化于 userData/auth.json）。
 *   2. 统一超时（AbortController，默认 30s）；下载数据流不走本模块
 *      （由 native-downloader / aria2 直接处理，因此不受此超时约束）。
 *   3. 非 2xx 统一抛出 {code, message, status} 错误（按契约解析 body.error）；
 *      401 时清理本地凭据并触发 onUnauthorized 回调（推送认证失效事件）。
 *   4. SERVER_BASE_URL 来自 settings.serverBase，默认 http://127.0.0.1:8080。
 */
const fs = require('fs');
const path = require('path');
const { net } = require('electron');

class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code || '请求失败');
    this.name = 'ApiError';
    this.code = code || ('HTTP_' + (status || 0));
    this.status = status || 0;
  }
}

function createApiClient({ userDataDir, settings }) {
  const authFile = path.join(userDataDir, 'auth.json');
  let auth = { token: null, user: null };
  let onUnauthorized = null;

  try {
    const saved = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    if (saved && saved.token) auth = saved;
  } catch (e) { /* 首次运行 */ }

  function saveAuth() {
    const tmp = authFile + '.tmp';
    fs.promises.writeFile(tmp, JSON.stringify(auth, null, 2), 'utf8')
      .then(() => fs.promises.rename(tmp, authFile))
      .catch(() => {});
  }

  /** 服务端基址（去尾部斜杠）。 */
  function base() {
    return String(settings.get('serverBase') || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  }

  function url(pathOrUrl) {
    return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : base() + pathOrUrl;
  }

  /**
   * 通用请求。
   * opts.body：对象 → JSON；字符串/Buffer/Uint8Array → 原样。
   * opts.auth === false 时不带 Bearer（公开接口，如 shares/resolve）。
   */
  async function request(method, pathOrUrl, opts = {}) {
    const { body, headers = {}, timeoutMs = 30000, auth: withAuth = true } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 外部信号（如上传分块的暂停中止）与内部超时合并：任一触发即中止请求
    if (opts.signal) {
      const ext = opts.signal;
      if (ext.aborted) controller.abort();
      else ext.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const h = Object.assign({}, headers);
    if (withAuth && auth.token) h['Authorization'] = 'Bearer ' + auth.token;
    if (body !== undefined && h['Content-Type'] === undefined && !(body instanceof Uint8Array)) {
      h['Content-Type'] = 'application/json';
    }
    let res;
    try {
      let payload;
      if (body === undefined) payload = undefined;
      else if (typeof body === 'string') payload = body;
      else if (body instanceof Uint8Array) payload = body;
      else payload = JSON.stringify(body);
      res = await net.fetch(url(pathOrUrl), {
        method,
        headers: h,
        body: payload,
        signal: controller.signal,
        redirect: 'follow'
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new ApiError('TIMEOUT', '请求超时（' + (timeoutMs / 1000) + 's）：' + url(pathOrUrl));
      }
      throw new ApiError('NETWORK', '网络错误：' + (e.message || '无法连接服务器') + '（' + url(pathOrUrl) + '）');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 && withAuth && auth.token) {
      clear();
      if (onUnauthorized) onUnauthorized();
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new ApiError(err.code || ('HTTP_' + res.status), err.message || ('请求失败（HTTP ' + res.status + '）'), res.status);
    }
    return data;
  }

  const get = (p, o) => request('GET', p, o);
  const post = (p, b, o) => request('POST', p, Object.assign({}, o, { body: b }));
  const put = (p, b, o) => request('PUT', p, Object.assign({}, o, { body: b }));
  const del = (p, o) => request('DELETE', p, o);

  function clear() {
    auth = { token: null, user: null };
    fs.promises.unlink(authFile).catch(() => {});
  }

  function setAuth(next) {
    auth = Object.assign({}, auth, next);
    saveAuth();
  }

  return {
    request, get, post, put, del,
    base, url,
    setAuth, clear,
    hasToken: () => !!auth.token,
    getUser: () => auth.user,
    getToken: () => auth.token,
    setOnUnauthorized: (fn) => { onUnauthorized = fn; }
  };
}

module.exports = { createApiClient, ApiError };
