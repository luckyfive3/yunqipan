/* files.js —— 文件页（window.Files）
 * 职责：目录浏览（面包屑）、新建文件夹、上传（对话框 + 拖拽）、多选批量下载/删除、
 *       解析链接入口、主题切换、配额条、顶栏搜索（本地文件名过滤）；
 *       行操作：预览/下载/分享/重命名/删除（图标按钮，悬停出现）。
 * 改版要点（百度网盘风）：彩色文件类型色块图标、40px 行高、悬停浅蓝背景、
 *       悬停浮现操作图标、空目录「这里空空如也」+ 上传按钮。
 */
(function () {
  'use strict';

  var Files = {
    cwd: { id: null, name: '全部文件' },
    items: [],
    selected: new Set(),
    refreshBusy: false,
    filter: ''
  };

  function $(id) { return document.getElementById(id); }

  function rowsEl() { return $('file-rows'); }

  function currentParentId() { return Files.cwd.id || null; }

  Files.init = function () {
    $('btn-new-folder').addEventListener('click', Files.newFolder);
    $('btn-upload').addEventListener('click', Files.pickAndUpload);
    $('btn-refresh').addEventListener('click', function () { Files.refresh(); });
    $('btn-parse').addEventListener('click', function () {
      var link = $('parse-input').value.trim();
      if (!link) { UI.toast('请先粘贴分享链接', 'warn'); return; }
      Parse.open(link);
    });
    $('parse-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('btn-parse').click();
    });
    $('btn-theme').addEventListener('click', Files.toggleTheme);
    $('btn-batch-download').addEventListener('click', Files.batchDownload);
    $('btn-batch-delete').addEventListener('click', Files.batchDelete);
    $('btn-batch-clear').addEventListener('click', function () { Files.clearSelection(); });

    // 顶栏搜索：本地过滤当前目录文件列表
    $('file-search').addEventListener('input', function () {
      Files.filter = this.value.trim().toLowerCase();
      Files.renderList();
    });

    // 拖拽上传：文件拖到窗口任意位置
    var page = $('page-files');
    page.addEventListener('dragover', function (e) { e.preventDefault(); });
    page.addEventListener('drop', function (e) {
      e.preventDefault();
      Files.handleDrop(e.dataTransfer ? e.dataTransfer.files : []);
    });
  };

  Files.show = function () {
    Files.refresh();
  };

  /** 切换目录时清空搜索过滤。 */
  Files.resetFilter = function () {
    Files.filter = '';
    var s = $('file-search');
    if (s) s.value = '';
  };

  /* ---------------- 数据 ---------------- */
  Files.refresh = async function () {
    if (Files.refreshBusy) return;
    Files.refreshBusy = true;
    try {
      var items = await UI.wp('files:list', { parentId: currentParentId() });
      if (items) {
        Files.items = items;
        Files.renderList();
      }
      Files.renderBreadcrumb();
      Files.refreshQuota();
    } finally {
      Files.refreshBusy = false;
    }
  };

  Files.refreshQuota = async function () {
    var user = await UI.wp('auth:me');
    if (!user) return;
    App.state.user = user;
    $('user-name').textContent = user.username || '';
    // 头像字母与下拉菜单同步
    var letter = (user.username || '未').charAt(0).toUpperCase();
    var avatarLetter = $('avatar-letter');
    if (avatarLetter) avatarLetter.textContent = letter;
    var menuUser = $('menu-user');
    if (menuUser) menuUser.textContent = user.username || '';
    var used = Number(user.quota_used || 0);
    var total = Number(user.quota_total || 0);
    var quotaText = '配额：已用 ' + UI.formatBytes(used) + ' / ' + (total > 0 ? UI.formatBytes(total) : '不限容量');
    $('quota-text').textContent = quotaText;
    var menuQuota = $('menu-quota');
    if (menuQuota) menuQuota.textContent = quotaText;
    if (total > 0) {
      $('quota-fill').style.width = Math.min(100, (used * 100) / total) + '%';
    } else {
      $('quota-fill').style.width = '0%';
    }
  };

  Files.renderBreadcrumb = async function () {
    var bar = $('breadcrumb');
    bar.innerHTML = '';
    var root = document.createElement('a');
    root.href = '#';
    root.textContent = '全部文件';
    root.addEventListener('click', function (e) {
      e.preventDefault();
      Files.cwd = { id: null, name: '全部文件' };
      Files.clearSelection();
      Files.resetFilter();
      Files.refresh();
    });
    bar.appendChild(root);
    if (!currentParentId()) {
      var cur = document.createElement('span');
      cur.className = 'cur';
      bar.appendChild(cur);
      return;
    }
    var chain = await UI.wp('files:path', { id: currentParentId() });
    if (chain && chain.length) {
      chain.forEach(function (node, i) {
        var sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '›';
        bar.appendChild(sep);
        if (i === chain.length - 1) {
          var cur2 = document.createElement('span');
          cur2.className = 'cur';
          cur2.textContent = node.name;
          bar.appendChild(cur2);
        } else {
          var a = document.createElement('a');
          a.href = '#';
          a.textContent = node.name;
          a.addEventListener('click', (function (nodeId) {
            return function (e) {
              e.preventDefault();
              Files.cwd = { id: nodeId, name: node.name };
              Files.clearSelection();
              Files.resetFilter();
              Files.refresh();
            };
          })(node.id));
          bar.appendChild(a);
        }
      });
    }
  };

  /* ---------------- 渲染 ---------------- */
  Files.renderList = function () {
    var box = rowsEl();
    box.innerHTML = '';
    // 空目录状态
    if (!Files.items.length) {
      var emptyBox = document.createElement('div');
      emptyBox.className = 'empty';
      var ic = document.createElement('span');
      ic.className = 'empty-ic';
      ic.textContent = '📂';
      emptyBox.appendChild(ic);
      emptyBox.appendChild(document.createTextNode('这里空空如也'));
      var upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'btn primary';
      upBtn.textContent = '⬆ 上传文件';
      upBtn.addEventListener('click', Files.pickAndUpload);
      emptyBox.appendChild(document.createElement('br'));
      emptyBox.appendChild(upBtn);
      box.appendChild(emptyBox);
      return;
    }
    var list = Files.items;
    if (Files.filter) {
      list = Files.items.filter(function (f) {
        return f.name.toLowerCase().indexOf(Files.filter) >= 0;
      });
      if (!list.length) {
        var noMatch = document.createElement('div');
        noMatch.className = 'empty';
        noMatch.textContent = '没有匹配「' + Files.filter + '」的文件';
        box.appendChild(noMatch);
        return;
      }
    }
    list.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'file-row' + (Files.selected.has(f.id) ? ' selected' : '');
      row.dataset.id = f.id;

      var check = document.createElement('span');
      check.className = 'col-check';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = Files.selected.has(f.id);
      cb.addEventListener('change', function () {
        if (cb.checked) Files.selected.add(f.id); else Files.selected.delete(f.id);
        row.classList.toggle('selected', cb.checked);
        Files.renderBatchBar();
      });
      check.appendChild(cb);

      var nameCell = document.createElement('span');
      nameCell.className = 'col-name';
      // 彩色文件类型色块（百度网盘风）
      var b = UI.fileBadge(f);
      var ic = document.createElement('span');
      ic.className = 'file-badge ' + b.cls;
      ic.textContent = b.label;
      var nm = document.createElement('span');
      nm.className = 'file-name';
      nm.textContent = f.name + (f.encrypted ? ' 🔒' : '');
      nm.title = f.name;
      nm.addEventListener('click', function () {
        if (f.is_dir) Files.enterDir(f);
        else if (UI.previewable(f)) Preview.open(f);
        else UI.toast('该类型不支持在线预览', 'warn');
      });
      nameCell.appendChild(ic);
      nameCell.appendChild(nm);

      var size = document.createElement('span');
      size.className = 'col-size';
      size.textContent = f.is_dir ? '—' : UI.formatBytes(f.size);

      var time = document.createElement('span');
      time.className = 'col-time';
      time.textContent = UI.formatTime(f.updated_at || f.created_at);

      var actions = document.createElement('span');
      actions.className = 'col-actions';
      actions.appendChild(Files.actionBtn('👁', '预览', function () { Preview.open(f); }, !UI.previewable(f)));
      actions.appendChild(Files.actionBtn('⬇', '下载', function () { Files.download(f); }, f.is_dir));
      actions.appendChild(Files.actionBtn('🔗', '分享', function () { Shares.createFor(f); }));
      actions.appendChild(Files.actionBtn('✏', '重命名', function () { Files.rename(f); }));
      var del = Files.actionBtn('🗑', '删除', function () { Files.remove(f); });
      del.classList.add('danger');
      actions.appendChild(del);

      row.appendChild(check);
      row.appendChild(nameCell);
      row.appendChild(size);
      row.appendChild(time);
      row.appendChild(actions);
      box.appendChild(row);
    });
    Files.renderBatchBar();
  };

  /** 图标化行操作按钮（悬停出现，title 提示）。 */
  Files.actionBtn = function (label, title, fn, disabled) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'row-btn';
    b.textContent = label;
    b.title = title;
    b.disabled = !!disabled;
    if (!disabled) b.addEventListener('click', fn);
    return b;
  };

  Files.renderBatchBar = function () {
    var bar = $('batch-bar');
    bar.classList.toggle('hidden', Files.selected.size === 0);
    $('batch-count').textContent = Files.selected.size;
  };

  Files.clearSelection = function () {
    Files.selected.clear();
    Files.renderList();
  };

  /* ---------------- 操作 ---------------- */
  Files.enterDir = function (item) {
    Files.cwd = { id: item.id, name: item.name };
    Files.clearSelection();
    Files.resetFilter();
    Files.refresh();
  };

  Files.newFolder = async function () {
    var name = await UI.prompt('新建文件夹', '输入文件夹名称');
    if (!name) return;
    var f = await UI.wp('files:mkdir', { parentId: currentParentId(), name: name });
    if (f) { UI.toast('已创建文件夹', 'ok'); Files.refresh(); }
  };

  Files.rename = async function (file) {
    var name = await UI.prompt('重命名', '输入新名称', file.name);
    if (!name || name === file.name) return;
    var f = await UI.wp('files:rename', { id: file.id, name: name });
    if (f) Files.refresh();
  };

  Files.remove = async function (file) {
    var yes = await UI.confirm(
      file.is_dir ? '确定删除文件夹「' + file.name + '」及其全部内容吗？此操作不可恢复。' : '确定删除文件「' + file.name + '」吗？'
    );
    if (!yes) return;
    var r = await UI.wp('files:remove', { id: file.id, recursive: !!file.is_dir });
    if (r !== null) {
      Files.selected.delete(file.id);
      UI.toast('已删除', 'ok');
      Files.refresh();
    }
  };

  Files.batchDelete = async function () {
    var ids = [...Files.selected];
    if (!ids.length) return;
    var yes = await UI.confirm('确定删除选中的 ' + ids.length + ' 项吗？此操作不可恢复。');
    if (!yes) return;
    var all = true;
    for (var id of ids) {
      var f = Files.items.find(function (x) { return x.id === id; });
      var r = await UI.wp('files:remove', { id: id, recursive: !!(f && f.is_dir) });
      if (r === null) all = false;
    }
    if (all) UI.toast('批量删除完成', 'ok');
    Files.clearSelection();
    Files.refresh();
  };

  Files.download = async function (file) {
    if (file.is_dir) { UI.toast('目录不支持直接下载', 'warn'); return; }
    var r = await UI.wp('download:start', {
      source: { type: 'file', fileId: file.id },
      name: file.name,
      size: file.size,
      destDir: App.state.settings.downloadDir || undefined,
      threads: App.state.settings.defaultThreads || 8
    });
    if (r !== null) UI.toast('已加入下载队列', 'ok');
  };

  Files.batchDownload = function () {
    var files = Files.items.filter(function (f) { return Files.selected.has(f.id) && !f.is_dir; });
    if (!files.length) { UI.toast('没有可下载的文件（目录不支持直接下载）', 'warn'); return; }
    files.forEach(function (f) {
      UI.wp('download:start', {
        source: { type: 'file', fileId: f.id },
        name: f.name,
        size: f.size,
        destDir: App.state.settings.downloadDir || undefined,
        threads: App.state.settings.defaultThreads || 8
      });
    });
    UI.toast('已加入下载队列：' + files.length + ' 个文件', 'ok');
    Files.clearSelection();
  };

  Files.pickAndUpload = async function () {
    var r = await UI.wp('app:pickFile', { multi: true, title: '选择要上传的文件' });
    if (!r || !r.paths || !r.paths.length) return;
    Files.uploadPaths(r.paths);
  };

  Files.handleDrop = function (fileList) {
    var paths = [];
    for (var i = 0; i < fileList.length; i++) {
      var p = window.wp.getPathForFile(fileList[i]);
      if (p) paths.push(p);
    }
    if (paths.length) Files.uploadPaths(paths);
  };

  Files.uploadPaths = function (paths) {
    var count = 0;
    paths.forEach(async function (p) {
      var r = await UI.wp('upload:start', { localPath: p, parentId: currentParentId() });
      if (r) count++;
    });
    setTimeout(function () {
      if (count) UI.toast('已加入上传队列：' + count + ' 个文件', 'ok');
      Files.refresh();
    }, 400);
  };

  Files.toggleTheme = async function () {
    var theme = App.state.settings.theme === 'dark' ? 'light' : 'dark';
    await UI.wp('settings:set', { key: 'theme', value: theme });
    UI.applyTheme(theme);
    if (App.state.settings) App.state.settings.theme = theme;
    $('btn-theme').textContent = theme === 'dark' ? '☀' : '🌙';
    var menuTheme = $('menu-theme');
    if (menuTheme) menuTheme.textContent = theme === 'dark' ? '☀ 切换主题' : '🌙 切换主题';
  };

  window.Files = Files;
})();
