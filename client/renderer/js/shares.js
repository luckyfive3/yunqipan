/* shares.js —— 分享页（window.Shares）
 * 职责：我的分享列表（文件名、链接、提取码、有效期、下载次数、复制、删除）
 *       与新建分享弹窗（文件树选择、提取码、有效期小时、次数上限）。
 *       分享链接 = serverBase + /s/{token}。
 */
(function () {
  'use strict';

  var Shares = {
    list: []
  };

  Shares.init = function () {
    document.getElementById('btn-new-share').addEventListener('click', Shares.openCreate);
    document.getElementById('btn-share-refresh').addEventListener('click', function () { Shares.refresh(); });
  };

  Shares.show = function () {
    Shares.refresh();
  };

  Shares.refresh = async function () {
    var shares = await UI.wp('shares:list');
    if (!shares) return;
    Shares.list = shares;
    Shares.render();
  };

  Shares.render = function () {
    var box = document.getElementById('share-list');
    box.innerHTML = '';
    if (!Shares.list.length) {
      box.innerHTML = '<div class="empty">还没有分享～点击「新建分享」把文件分享给朋友吧</div>';
      return;
    }
    Shares.list.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'share-row';

      var info = document.createElement('div');
      info.className = 'share-info';
      var link = App.state.settings.serverBase + '/s/' + s.token;
      info.innerHTML =
        '<div class="share-name">' + UI.escapeHtml(s.file_name) + '</div>' +
        '<div class="share-link" title="' + UI.escapeHtml(link) + '">' + UI.escapeHtml(link) + '</div>';

      var tags = document.createElement('div');
      tags.className = 'share-tags';
      var tag = function (t) {
        var s2 = document.createElement('span');
        s2.className = 'tag';
        s2.textContent = t;
        tags.appendChild(s2);
      };
      tag(s.require_code ? '🔑 提取码：' + '••••' : '无提取码');
      tag(s.expires_at ? '有效期至 ' + UI.formatTime(s.expires_at) : '永久有效');
      tag('下载 ' + (s.downloads || 0) + (s.max_downloads ? ' / ' + s.max_downloads : ' 次（不限）'));

      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn small';
      copyBtn.textContent = '复制链接';
      copyBtn.addEventListener('click', function () {
        UI.copyText(App.state.settings.serverBase + '/s/' + s.token);
      });
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn small danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', async function () {
        var yes = await UI.confirm('确定删除该分享吗？删除后链接立即失效。');
        if (!yes) return;
        var r = await UI.wp('shares:remove', { id: s.id });
        if (r !== null) Shares.refresh();
      });

      var actions = document.createElement('div');
      actions.className = 't-actions';
      actions.appendChild(copyBtn);
      actions.appendChild(delBtn);

      row.appendChild(info);
      row.appendChild(tags);
      row.appendChild(actions);
      box.appendChild(row);
    });
  };

  /** 从文件页入口创建分享（已选中文件）。 */
  Shares.createFor = function (file) {
    Shares.openCreate(file);
  };

  Shares.openCreate = function (preset) {
    var modal = UI.openModal({
      title: '新建分享' + (preset ? '：' + preset.name : ''),
      body:
        '<div class="form-field" style="margin-bottom:10px">' +
        '<label>选择文件（点击展开目录）</label>' +
        '<div class="picker" id="share-picker"><div class="empty" style="padding:20px">加载文件树…</div></div>' +
        '</div>' +
        '<div class="form-row" style="padding:0">' +
        '<div class="form-field check-field"><label><input id="share-code" type="checkbox"> 需要提取码</label></div>' +
        '<div class="form-field"><label>提取码（4-8 位）</label><input id="share-code-val" type="text" placeholder="如 1234" maxlength="8" disabled></div>' +
        '<div class="form-field"><label>有效期（小时，0=永久）</label><input id="share-hours" type="number" min="0" value="0"></div>' +
        '<div class="form-field"><label>下载次数上限（0=不限）</label><input id="share-max" type="number" min="0" value="0"></div>' +
        '</div>',
      buttons: [
        { label: '取消', cls: 'ghost' },
        { label: '创建分享', cls: 'primary', onClick: function (m) { return Shares.submitCreate(m, preset); } }
      ]
    });

    var picker = modal.querySelector('#share-picker');
    modal.querySelector('#share-code').addEventListener('change', function () {
      modal.querySelector('#share-code-val').disabled = !this.checked;
    });

    // 文件树加载
    UI.wp('files:tree').then(function (items) {
      if (!items) { picker.innerHTML = '<div class="empty">文件树加载失败</div>'; return; }
      Shares.buildPicker(picker, items, preset);
    });
  };

  /** 扁平树 → 目录缩进列表（目录可展开/折叠，文件单选）。 */
  Shares.buildPicker = function (picker, items, preset) {
    var chosen = preset ? preset.id : Shares.readChosen(picker);
    picker.innerHTML = '';
    var children = new Map();
    items.forEach(function (it) {
      var key = it.parent_id || '__root__';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(it);
    });
    var expanded = new Set(['__root__']);

    var renderLevel = function (parentKey, depth) {
      var list = children.get(parentKey) || [];
      list.slice().sort(function (a, b) {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name < b.name ? -1 : 1;
      }).forEach(function (node) {
        var row = document.createElement('div');
        row.className = 'picker-node' + (node.is_dir ? ' dir' : '');
        row.style.paddingLeft = (10 + depth * 18) + 'px';
        if (node.is_dir) {
          var arrow = document.createElement('span');
          arrow.className = 'arrow';
          arrow.textContent = expanded.has(node.id) ? '▾' : '▸';
          var ic = document.createElement('span');
          ic.className = 'file-icon';
          ic.textContent = '📁';
          var nm = document.createElement('span');
          nm.textContent = node.name;
          row.appendChild(arrow);
          row.appendChild(ic);
          row.appendChild(nm);
          row.addEventListener('click', function () {
            if (expanded.has(node.id)) expanded.delete(node.id);
            else expanded.add(node.id);
            Shares.buildPicker(picker, items, { id: Shares.readChosen(picker) });
          });
        } else {
          var radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'share-file';
          radio.dataset.nodeId = node.id;
          radio.checked = chosen === node.id;
          var ic2 = document.createElement('span');
          ic2.className = 'file-icon';
          ic2.textContent = UI.fileIcon(node);
          var nm2 = document.createElement('span');
          nm2.textContent = node.name + '（' + UI.formatBytes(node.size) + '）';
          row.appendChild(radio);
          row.appendChild(ic2);
          row.appendChild(nm2);
          row.addEventListener('click', function () { radio.checked = true; });
        }
        picker.appendChild(row);
        if (node.is_dir && expanded.has(node.id)) renderLevel(node.id, depth + 1);
      });
    };
    renderLevel('__root__', 0);
  };

  Shares.submitCreate = async function (modal, preset) {
    var picker = modal.querySelector('#share-picker');
    var fileId = preset ? preset.id : Shares.readChosen(picker);
    if (!fileId) { UI.toast('请先选择一个文件', 'warn'); return true; }
    var requireCode = modal.querySelector('#share-code').checked;
    var code = modal.querySelector('#share-code-val').value.trim();
    if (requireCode && !/^\d{4,8}$/.test(code)) { UI.toast('提取码需为 4-8 位数字', 'warn'); return true; }
    var hours = parseInt(modal.querySelector('#share-hours').value, 10) || 0;
    var max = parseInt(modal.querySelector('#share-max').value, 10) || 0;

    var r = await UI.wp('shares:create', {
      fileId: fileId,
      requireCode: requireCode,
      extractCode: code,
      expiresHours: hours,
      maxDownloads: max
    });
    if (r && r.url) {
      UI.toast('分享创建成功，链接已复制', 'ok');
      UI.copyText(r.url);
      Shares.refresh();
    }
    return false;
  };

  /** 从当前 radio 选中读取 fileId。 */
  Shares.readChosen = function (picker) {
    var checked = picker.querySelector('input[name="share-file"]:checked');
    return checked ? checked.dataset.nodeId : null;
  };

  window.Shares = Shares;
})();
