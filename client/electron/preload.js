'use strict';
/**
 * preload.js —— 渲染层安全桥（contextBridge）
 *
 * 职责：
 *   1. 通过 contextBridge 暴露 window.wp，渲染层只能经它访问主进程能力。
 *   2. invoke(channel, payload) → ipcRenderer.invoke('wp:invoke', channel, payload)，
 *      返回统一 {ok, data|error} 结构。
 *   3. on(event, cb) → 订阅主进程推送的 'wp:event'；主进程 200ms 节流可能批量发送
 *      （对象或数组），此处负责拆包后按 type 分发给订阅者。
 *   4. getPathForFile(file)：拖拽文件的真实本地路径（webUtils.getPathForFile，
 *      渲染层 sandbox 下无法直接拿 File.path）。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('wp', {
  invoke: (channel, payload) => ipcRenderer.invoke('wp:invoke', channel, payload),

  on: (event, cb) => {
    ipcRenderer.on('wp:event', (_e, msg) => {
      const list = Array.isArray(msg) ? msg : [msg];
      for (const m of list) {
        if (m && (event === '*' || m.type === event)) {
          try { cb(m.payload); } catch (err) { /* 渲染层回调异常不影响其他订阅 */ }
        }
      }
    });
  },

  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (e) {
      return null;
    }
  }
});
