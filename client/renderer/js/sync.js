/* sync.js —— 同步页（window.Sync）
 * 职责：目录选择、模式（双向/仅上传/仅下载）、间隔、排除规则、启停、立即扫描、最近事件列表。
 *       配置经 sync:configure 持久化；状态经 sync:status 事件实时刷新。
 */
(function () {
  'use strict';

  var Sync = {
    status: { running: false, lastScan: null, lastError: null, pending: 0, events: [] }
  };

  Sync.init = function () {
    document.getElementById('btn-sync-pick').addEventListener('click', Sync.pickDir);
    document.getElementById('btn-sync-toggle').addEventListener('click', Sync.toggle);
    document.getElementById('btn-sync-now').addEventListener('click', function () { Sync.scanNow(); });

    ['sync-mode', 'sync-interval', 'sync-exclude'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', Sync.saveConfig);
    });

    // 主进程状态推送
    window.wp.on('sync:status', function (p) {
      if (!p) return;
      Sync.status = p;
      Sync.renderStatus();
      Sync.renderEvents();
    });
  };

  Sync.show = async function () {
    var cfg = await UI.wp('sync:status');
    if (cfg) {
      Sync.status = cfg;
      var s = App.state.settings.sync || {};
      document.getElementById('sync-local-root').value = s.localRoot || '';
      document.getElementById('sync-mode').value = s.mode || 'twoway';
      document.getElementById('sync-interval').value = s.intervalSec || 30;
      document.getElementById('sync-exclude').value = (s.exclude || []).join(', ');
    }
    Sync.renderStatus();
    Sync.renderEvents();
  };

  Sync.pickDir = async function () {
    var r = await UI.wp('app:pickDirectory', { title: '选择本地同步目录' });
    if (!r || !r.path) return;
    document.getElementById('sync-local-root').value = r.path;
    Sync.saveConfig();
  };

  Sync.saveConfig = async function () {
    var cfg = {
      localRoot: document.getElementById('sync-local-root').value.trim(),
      mode: document.getElementById('sync-mode').value,
      intervalSec: Math.max(5, parseInt(document.getElementById('sync-interval').value, 10) || 30),
      exclude: document.getElementById('sync-exclude').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean)
    };
    var saved = await UI.wp('sync:configure', { config: cfg });
    if (saved) App.state.settings.sync = saved;
  };

  Sync.toggle = async function () {
    if (Sync.status.running) {
      var r = await UI.wp('sync:stop');
      if (r) Sync.status = r;
    } else {
      await Sync.saveConfig();
      var r2 = await UI.wp('sync:start');
      if (r2) Sync.status = r2;
    }
    Sync.renderStatus();
  };

  Sync.scanNow = async function () {
    await Sync.saveConfig();
    var r = await UI.wp('sync:scanNow');
    if (r) { Sync.status = r; Sync.renderStatus(); Sync.renderEvents(); }
  };

  Sync.renderStatus = function () {
    var s = Sync.status;
    var el = document.getElementById('sync-status');
    var btn = document.getElementById('btn-sync-toggle');
    el.classList.toggle('running', !!s.running);
    el.textContent = s.running
      ? '运行中' + (s.lastScan ? ' · 上次扫描 ' + UI.formatTime(s.lastScan) : '')
      : (s.lastError ? '未运行 · ' + s.lastError : '未运行');
    btn.textContent = s.running ? '⏸ 停止同步' : '▶ 启动同步';
  };

  Sync.renderEvents = function () {
    var box = document.getElementById('sync-events');
    var events = Sync.status.events || [];
    box.innerHTML = '';
    if (!events.length) {
      box.innerHTML = '<div class="empty" style="padding:20px">暂无事件</div>';
      return;
    }
    events.forEach(function (ev) {
      var row = document.createElement('div');
      row.className = 'sync-event';
      var t = document.createElement('span');
      t.className = 'time';
      t.textContent = UI.formatTime(ev.time);
      var m = document.createElement('span');
      m.className = 'msg';
      m.textContent = ev.message;
      row.appendChild(t);
      row.appendChild(m);
      box.appendChild(row);
    });
  };

  window.Sync = Sync;
})();
