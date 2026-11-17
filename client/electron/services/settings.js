'use strict';
/**
 * settings.js —— 设置服务
 *
 * 职责：
 *   1. 管理 userData/settings.json：默认值 DEFAULTS + 深度合并 + 300ms 防抖写盘 + tmp 原子替换。
 *   2. 提供 get(key?)/set(key, value)/flushNow()，供 api-client、传输队列、下载引擎、
 *      同步服务与 IPC settings:* 通道共用。
 *   3. 由 main.js 在启动时初始化（并填充 downloadDir/cacheDir 运行时路径），
 *      退出前调用 flushNow() 强制落盘。
 */
const fs = require('fs');
const path = require('path');

/** 全部默认值。downloadDir / cacheDir 为空时由 main.js 用 app 运行时路径填充。 */
const DEFAULTS = {
  theme: 'light',
  serverBase: '', // 空 = 自动（内置单机服务端）；填 http://ip:端口 = 连接远程服务端
  downloadDir: '',
  cacheDir: '',
  maxDownloadTasks: 3,
  maxUploadTasks: 3,
  defaultThreads: 8,
  maxThreadsPerFile: 32,
  limitDownKbps: 0,
  limitUpKbps: 0,
  aria2Enabled: false,
  aria2Path: '',
  parsers: { baidu: false, quark: false },
  e2eDefault: false,
  e2ePassphrase: 'yunqipan',
  autoResume: true,
  // 上传分块大小（1 ~ 64 MiB，默认 4 MiB），与服务端契约 chunk_size 范围一致
  uploadChunkSize: 8388608,
  sync: {
    enabled: false,
    localRoot: '',
    remoteRootId: null,
    mode: 'twoway',
    intervalSec: 30,
    exclude: []
  }
};

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** 深度合并：对象递归合并，其余（数组/原始值）整体替换。 */
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    out[k] = isPlainObject(base[k]) ? deepMerge(base[k], patch[k]) : patch[k];
  }
  return out;
}

function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

function createSettings({ userDataDir }) {
  const file = path.join(userDataDir, 'settings.json');
  let data = deepClone(DEFAULTS);
  let dirty = false;
  let timer = null;

  function scheduleWrite() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flushNow().catch(() => {}); }, 300);
  }

  /** 启动时加载；文件不存在或损坏时静默回退默认值。 */
  async function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      data = deepMerge(deepClone(DEFAULTS), parsed);
    } catch (e) { /* 首次运行或文件损坏：使用默认值 */ }
  }

  /** key 支持点路径，如 'parsers.baidu'；省略 key 返回全量深拷贝。 */
  function get(key) {
    if (key === undefined) return deepClone(data);
    return deepClone(key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data));
  }

  /** 设置：对象值深度合并，其余替换；返回设置后的完整值。 */
  function set(key, value) {
    const keys = String(key).split('.');
    let node = data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!isPlainObject(node[keys[i]])) node[keys[i]] = {};
      node = node[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (isPlainObject(node[last]) && isPlainObject(value)) node[last] = deepMerge(node[last], value);
    else node[last] = value;
    scheduleWrite();
    return get();
  }

  /** 立即落盘（原子替换：先写 .tmp 再 rename）。 */
  async function flushNow() {
    if (!dirty) return;
    dirty = false;
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  }

  return { load, get, set, flushNow, file };
}

module.exports = { createSettings, DEFAULTS, deepMerge };
