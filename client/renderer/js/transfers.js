/* transfers.js —— 传输页（window.Transfers）
 * 职责：统一传输列表（上传/下载/直链徽标、进度、速度、状态、暂停/继续/取消/重试/打开目录）、
 *       批量操作、底部聚合上下行速度与任务数；订阅主进程 transfer:update / transfers:summary 事件。
 */
(function () {
  'use strict';

  var Transfers = {
    tasks: new Map(),
    rows: new Map(),
    summary: { downSpeed: 0, upSpeed: 0, running: 0, queued: 0, done: 0 }
  };

  function listEl() { return document.getElementById('transfer-list'); }

  Transfers.init = function () {
    document.getElementById('btn-pause-all').addEventListener('click', Transfers.pauseAll);
    document.getElementById('btn-resume-all').addEventListener('click', Transfers.resumeAll);
    document.getElementById('btn-clear-finished').addEventListener('click', Transfers.clearFinished);

    // 底部状态栏传输摘要：点击跳转到传输页
    var gs = document.getElementById('global-summary');
    if (gs) gs.addEventListener('click', function () { App.showPage('transfers'); });

    // 主进程推送：单任务更新 → 增量更新行；批量到达时逐个分发
    window.wp.on('transfer:update', function (p) {
      if (!p || !p.task) return;
      Transfers.upsert(p.task);
    });
    window.wp.on('transfers:summary', function (p) {
      if (p && p.summary) { Transfers.summary = p.summary; Transfers.renderSummary(); }
    });
  };

  Transfers.show = function () {
    Transfers.reload();
  };

  Transfers.reload = async function () {
    var r = await UI.wp('transfers:list');
    if (!r) return;
    Transfers.rows = new Map();
    listEl().innerHTML = '';
    (r.tasks || []).forEach(function (t) {
      Transfers.tasks.set(t.id, t);
      Transfers.appendRow(t, true);
    });
    if (!(r.tasks || []).length) {
      listEl().innerHTML = '<div class="empty">暂无传输任务，去「文件」页下载或上传吧～</div>';
    }
    Transfers.summary = r.summary || Transfers.summary;
    Transfers.renderSummary();
  };

  /** 事件驱动的单任务更新：存在则原地更新，不存在则插到顶部。 */
  Transfers.upsert = function (task) {
    Transfers.tasks.set(task.id, task);
    var row = Transfers.rows.get(task.id);
    if (!row) {
      var empty = listEl().querySelector('.empty');
      if (empty) empty.remove();
      Transfers.appendRow(task, true);
      Transfers.renderSummary();
      return;
    }
    var parent = row.parentNode;
    var fresh = Transfers.buildRow(task);
    parent.replaceChild(fresh, row);
    Transfers.rows.set(task.id, fresh);
  };

  Transfers.appendRow = function (task, prepend) {
    var row = Transfers.buildRow(task);
    if (prepend && listEl().firstChild) listEl().insertBefore(row, listEl().firstChild);
    else listEl().appendChild(row);
    Transfers.rows.set(task.id, row);
  };

  Transfers.buildRow = function (task) {
    var row = document.createElement('div');
    row.className = 't-row';

    // 徽标
    var badgeText = task.kind === 'upload' ? '上传' : (task.source && task.source.type === 'url' ? '直链' : '下载');
    var badgeCls = task.kind === 'upload' ? 'upload' : (task.source && task.source.type === 'url' ? 'direct' : 'download');

    var top = document.createElement('div');
    top.className = 't-top';
    top.innerHTML =
      '<span class="t-badge ' + badgeCls + '">' + badgeText + '</span>' +
      '<span class="t-name" title="' + UI.escapeHtml(task.name || '') + '">' + UI.escapeHtml(task.name || '') + '</span>' +
      '<span class="t-status ' + task.status + '">' + UI.statusText(task) + '</span>' +
      '<span class="t-speed">' + (task.status === 'running' ? UI.formatSpeed(task.speed || 0) : '') + '</span>';

    var actions = document.createElement('span');
    actions.className = 't-actions';
    var btns = Transfers.actionButtons(task);
    btns.forEach(function (b) { actions.appendChild(b); });
    top.appendChild(actions);
    row.appendChild(top);

    // 进度条
    var pct = task.progress || 0;
    var bar = document.createElement('div');
    bar.className = 't-progress' + (task.size > 0 ? '' : ' indeterminate');
    var fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);

    // 元信息
    var meta = document.createElement('div');
    meta.className = 't-meta';
    var sizeText = UI.formatBytes(task.done) + (task.size > 0 ? ' / ' + UI.formatBytes(task.size) : '');
    var errText = task.error ? ' · ' + task.error.message : '';
    meta.textContent = sizeText + ' · ' + UI.shortPath(task.destPath || '') + errText;
    row.appendChild(meta);

    return row;
  };

  Transfers.actionButtons = function (task) {
    var out = [];
    var btn = function (label, cls, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small ' + (cls || '');
      b.textContent = label;
      b.addEventListener('click', fn);
      out.push(b);
    };
    if (task.status === 'running') {
      btn('暂停', '', function () { Transfers.op(task.kind + ':pause', { id: task.id }); });
      btn('取消', 'danger', function () { Transfers.op(task.kind + ':cancel', { id: task.id }); });
    } else if (task.status === 'paused') {
      btn('继续', 'primary', function () { Transfers.op(task.kind + ':resume', { id: task.id }); });
      btn('取消', 'danger', function () { Transfers.op(task.kind + ':cancel', { id: task.id }); });
    } else if (task.status === 'queued') {
      btn('取消', 'danger', function () { Transfers.op(task.kind + ':cancel', { id: task.id }); });
    } else if (task.status === 'error') {
      if (task.kind === 'download') btn('重试', 'primary', function () { Transfers.op('download:retry', { id: task.id }); });
      else btn('继续', 'primary', function () { Transfers.op('upload:resume', { id: task.id }); });
      btn('取消', 'danger', function () { Transfers.op(task.kind + ':cancel', { id: task.id }); });
    } else if (task.status === 'done') {
      btn('打开目录', '', function () { Transfers.op('app:reveal', { path: task.destPath }); });
    }
    return out;
  };

  Transfers.op = async function (channel, payload) {
    var r = await UI.wp(channel, payload);
    if (r === null) return;
    // 打开目录受限降级：路径已复制到剪贴板，明确提示用户
    if (channel === 'app:reveal' && r && r.fallback) {
      UI.toast('当前环境无法打开资源管理器，路径已复制到剪贴板：' + r.path, 'info');
      return;
    }
    Transfers.reload();
  };

  Transfers.pauseAll = function () {
    var count = 0;
    Transfers.tasks.forEach(function (t) {
      if (t.status === 'running') { UI.wp(t.kind + ':pause', { id: t.id }); count++; }
    });
    if (!count) UI.toast('没有进行中的任务', 'info');
    else UI.toast('已暂停 ' + count + ' 个任务', 'ok');
  };

  Transfers.resumeAll = function () {
    var count = 0;
    Transfers.tasks.forEach(function (t) {
      if (t.status === 'paused') { UI.wp(t.kind + ':resume', { id: t.id }); count++; }
    });
    if (!count) UI.toast('没有已暂停的任务', 'info');
    else UI.toast('已继续 ' + count + ' 个任务', 'ok');
  };

  Transfers.clearFinished = async function () {
    await UI.wp('transfers:clearFinished');
    Transfers.reload();
  };

  Transfers.renderSummary = function () {
    var s = Transfers.summary || {};
    document.getElementById('sum-down').textContent = UI.formatSpeed(s.downSpeed || 0);
    document.getElementById('sum-up').textContent = UI.formatSpeed(s.upSpeed || 0);
    document.getElementById('sum-running').textContent = s.running || 0;
    document.getElementById('sum-queued').textContent = s.queued || 0;
    document.getElementById('sum-done').textContent = s.done || 0;
  };

  window.Transfers = Transfers;
})();
