/* parse.js —— 解析链接弹层（window.Parse）
 * 职责：输入分享链接 → parse:resolve（云栖盘 /s/ 链接走服务端 shares.resolve；直链走 http-direct；
 *       百度/夸克需在设置开启，默认禁用）→ 文件树/列表勾选 + 线程数 + 保存位置 → 加入下载队列；
 *       需要提取码时弹输入框；失败显示后端中文错误（统一 toast）。
 */
(function () {
  'use strict';

  var Parse = {
    ctx: null,       // {type:'share'|'url', token, files, tree}
    link: '',
    code: '',
    destDir: ''
  };

  Parse.init = function () { /* 弹层按需创建 */ };

  Parse.open = async function (link, code) {
    Parse.link = link;
    Parse.code = code || '';
    Parse.destDir = App.state.settings.downloadDir || '';

    var modal = UI.openModal({
      title: '解析分享链接',
      body:
        '<div class="form-field" style="margin-bottom:12px">' +
        '<label>链接 / cURL 命令（支持粘贴浏览器「复制为 cURL(bash)」加速官方下载链接）</label>' +
        '<textarea id="parse-link" rows="4" style="width:100%;resize:vertical">' + UI.escapeHtml(link) + '</textarea>' +
        '</div>' +
        '<div id="parse-code-box" class="form-field hidden" style="margin-bottom:12px">' +
        '<label>提取码</label><input id="parse-code" type="text" placeholder="请输入提取码">' +
        '</div>' +
        '<div id="parse-body"><div class="empty" style="padding:24px">解析中…</div></div>',
      footer: false,
      buttons: []
    });
    // footer:false 下自定义底部按钮区
    var foot = document.createElement('div');
    foot.className = 'modal-foot';
    var threadsInput = document.createElement('input');
    threadsInput.type = 'number';
    threadsInput.min = 1;
    threadsInput.max = 32;
    threadsInput.value = App.state.settings.defaultThreads || 8;
    threadsInput.style.width = '70px';
    var dirBtn = document.createElement('button');
    dirBtn.type = 'button';
    dirBtn.className = 'btn';
    dirBtn.textContent = '保存到…';
    var goBtn = document.createElement('button');
    goBtn.type = 'button';
    goBtn.className = 'btn primary';
    goBtn.textContent = '加入下载队列';
    var hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '线程数：';
    foot.appendChild(hint);
    foot.appendChild(threadsInput);
    foot.appendChild(dirBtn);
    foot.appendChild(goBtn);
    modal.querySelector('.modal').appendChild(foot);

    dirBtn.addEventListener('click', async function () {
      var r = await UI.wp('app:pickDirectory', { title: '选择保存位置' });
      if (r && r.path) { Parse.destDir = r.path; dirBtn.textContent = '保存到 ' + UI.shortPath(r.path, 24); }
    });

    var resolveFn = async function (withCode) {
      Parse.code = withCode || '';
      var bodyEl = modal.querySelector('#parse-body');
      bodyEl.innerHTML = '<div class="empty" style="padding:24px">解析中…</div>';
      try {
        // 直接调用 invoke 以便区分“需要提取码”错误
        var r = await window.wp.invoke('parse:resolve', { link: Parse.link, code: Parse.code });
        if (!r || !r.ok) {
          var err = (r && r.error) || {};
          if (err.code === 'SHARE_CODE_REQUIRED' || err.code === 'SHARE_CODE_INVALID') {
            modal.querySelector('#parse-code-box').classList.remove('hidden');
            bodyEl.innerHTML = '<div class="empty" style="padding:24px">该分享需要提取码，请输入后回车</div>';
            var ci = modal.querySelector('#parse-code');
            if (!ci.value) ci.focus();
          } else {
            bodyEl.innerHTML = '<div class="empty" style="padding:24px">' + UI.escapeHtml(err.message || '解析失败') + '</div>';
          }
          return;
        }
        Parse.ctx = r.data;
        Parse.checkedShare = new Set();
        modal.querySelector('#parse-code-box').classList.add('hidden');
        if (r.data.type === 'share') Parse.renderShareTree(bodyEl, r.data);
        else Parse.renderFileList(bodyEl, r.data);
      } catch (e) {
        // 渲染/解析异常兜底：绝不拖垮渲染进程
        bodyEl.innerHTML = '<div class="empty" style="padding:24px">' +
          UI.escapeHtml('解析异常：' + ((e && e.message) || e)) + '</div>';
      }
    };
    resolveFn(Parse.code);

    modal.querySelector('#parse-link').addEventListener('change', function () {
      Parse.link = this.value.trim();
      resolveFn('');
    });
    var codeInput = modal.querySelector('#parse-code');
    codeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') resolveFn(this.value.trim());
    });

    goBtn.addEventListener('click', function () { Parse.submit(modal, threadsInput); });
  };

  /** 云栖盘分享：ShareNode 扁平树 → 勾选树（勾选目录 = 勾选全部子孙文件）。 */
  Parse.renderShareTree = function (box, r) {
    var nodes = r.tree || [];
    var children = new Map();
    nodes.forEach(function (n) { children.set(n.id, n); });
    var byParent = new Map();
    nodes.forEach(function (n) {
      var key = n.parent_share_id || '__root__';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(n);
    });
    var fileNodes = nodes.filter(function (n) { return !n.is_dir; });

    box.innerHTML =
      '<div class="hint" style="margin-bottom:8px">' + UI.escapeHtml(r.share ? r.share.file_name : '') +
      '（剩余下载次数：' + (r.share && r.share.remaining_downloads !== undefined ? r.share.remaining_downloads : '—') + '）</div>' +
      '<div class="picker" style="max-height:260px" id="parse-tree"></div>';

    var treeEl = box.querySelector('#parse-tree');
    var expanded = new Set(['__root__']);
    var renderLevel = function (parentKey, depth) {
      var list = byParent.get(parentKey) || [];
      list.slice().sort(function (a, b) {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name < b.name ? -1 : 1;
      }).forEach(function (node) {
        var row = document.createElement('div');
        row.className = 'picker-node' + (node.is_dir ? ' dir' : '');
        row.style.paddingLeft = (10 + depth * 18) + 'px';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.nodeId = node.id;
        if (node.is_dir) {
          input.dataset.dir = '1';
          var arrow = document.createElement('span');
          arrow.className = 'arrow';
          arrow.textContent = expanded.has(node.id) ? '▾' : '▸';
          var ic = document.createElement('span');
          ic.className = 'file-icon';
          ic.textContent = '📁';
          var nm = document.createElement('span');
          nm.textContent = node.name;
          row.appendChild(input);
          row.appendChild(arrow);
          row.appendChild(ic);
          row.appendChild(nm);
          arrow.addEventListener('click', function () {
            if (expanded.has(node.id)) expanded.delete(node.id); else expanded.add(node.id);
            Parse.renderShareTree(box, r);
            Parse.syncDirChecks(box);
          });
        } else {
          var ic2 = document.createElement('span');
          ic2.className = 'file-icon';
          ic2.textContent = UI.fileIcon({ name: node.name, is_dir: false });
          var nm2 = document.createElement('span');
          nm2.textContent = node.name + '（' + UI.formatBytes(node.size) + '）';
          row.appendChild(input);
          row.appendChild(ic2);
          row.appendChild(nm2);
        }
        treeEl.appendChild(row);
        if (node.is_dir && expanded.has(node.id)) renderLevel(node.id, depth + 1);
      });
    };
    renderLevel('__root__', 0);

    treeEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.dataset.nodeId;
        var isDir = cb.dataset.dir === '1';
        if (isDir) {
          // 勾选目录 → 全部子孙文件同步勾选
          var subs = Parse.subtreeIds(id, children);
          treeEl.querySelectorAll('input[type="checkbox"]').forEach(function (c2) {
            if (subs.has(c2.dataset.nodeId)) c2.checked = cb.checked;
          });
        }
        Parse.syncDirChecks(box); // 立即同步勾选集，重建树时恢复
      });
    });
    // 重建后按勾选集恢复
    Parse.restoreChecks(treeEl);
  };

  Parse.subtreeIds = function (dirId, byId) {
    var out = new Set();
    var walk = function (id) {
      var node = byId.get(id);
      if (!node) return;
      if (node.is_dir) {
        // 扁平树：按 parent_share_id 找子节点
        for (var other of byId.values()) {
          if (other.parent_share_id === id) {
            if (other.is_dir) walk(other.id); else out.add(other.id);
          }
        }
      }
    };
    walk(dirId);
    return out;
  };

  /** 重建树时恢复勾选（勾选集保存在 Parse.checkedShare）。 */
  Parse.restoreChecks = function (treeEl) {
    var checked = Parse.checkedShare || new Set();
    treeEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      if (checked.has(cb.dataset.nodeId)) cb.checked = true;
    });
  };

  Parse.syncDirChecks = function (box) {
    var treeEl = box.querySelector('#parse-tree');
    if (!treeEl) return;
    Parse.checkedShare = new Set();
    treeEl.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
      Parse.checkedShare.add(cb.dataset.nodeId);
    });
  };

  /** 直链 / 第三方解析结果：文件列表勾选。 */
  Parse.renderFileList = function (box, r) {
    var rows = (r.files || []).map(function (f) {
      var disabled = !f.directUrl;
      return '<div class="picker-node">' +
        '<input type="checkbox" data-name="' + UI.escapeHtml(f.name) + '" data-size="' + (f.size || 0) + '"' +
        ' data-url="' + UI.escapeHtml(f.directUrl || '') + '"' + (disabled ? ' disabled' : '') + '>' +
        '<span class="file-icon">' + UI.fileIcon({ name: f.name, is_dir: false }) + '</span>' +
        '<span>' + UI.escapeHtml(f.name) + '（' + UI.formatBytes(f.size) + '）</span>' +
        (disabled ? '<span class="tag" style="margin-left:8px">无匿名直链</span>' : '') +
        '</div>';
    }).join('');
    var note = (r.provider === 'http-direct') ? '' :
      '<div class="hint warn-hint" style="margin-bottom:8px">合规提示：第三方解析仅处理匿名公开分享；无匿名直链的资源请使用官方客户端。</div>';
    box.innerHTML = note + '<div class="picker" style="max-height:260px">' +
      (rows || '<div class="empty">未解析到文件</div>') + '</div>';
  };

  Parse.submit = async function (modal, threadsInput) {
    var threads = Math.max(1, Math.min(32, parseInt(threadsInput.value, 10) || 8));
    var payload = { files: [], destDir: Parse.destDir, threads: threads };
    var count = 0;

    if (Parse.ctx && Parse.ctx.type === 'share') {
      var box = modal.querySelector('#parse-tree');
      if (!box) { UI.toast('请先完成解析', 'warn'); return; }
      var tree = Parse.ctx.tree || [];
      var byId = new Map();
      tree.forEach(function (n) { byId.set(n.id, n); });
      var wanted = new Set();
      box.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
        wanted.add(cb.dataset.nodeId);
        if (cb.dataset.dir === '1') Parse.subtreeIds(cb.dataset.nodeId, byId).forEach(function (x) { wanted.add(x); });
      });
      tree.forEach(function (n) {
        if (!n.is_dir && wanted.has(n.id)) {
          payload.files.push({ type: 'share', token: Parse.ctx.token, nodeId: n.id, name: n.name, size: n.size || 0 });
          count++;
        }
      });
    } else {
      var picks = modal.querySelectorAll('#parse-body input[type="checkbox"]:checked');
      picks.forEach(function (cb) {
        if (!cb.dataset.url) return;
        payload.files.push({
          type: 'url',
          url: cb.dataset.url,
          name: cb.dataset.name,
          size: parseInt(cb.dataset.size, 10) || 0,
          headers: {}
        });
        count++;
      });
    }

    if (!count) { UI.toast('请先勾选要下载的文件', 'warn'); return; }
    var r = await UI.wp('parse:download', payload);
    if (r !== null) {
      UI.toast('已加入下载队列：' + count + ' 个文件', 'ok');
      UI.closeModal();
      App.showPage('transfers');
    }
  };

  window.Parse = Parse;
})();
