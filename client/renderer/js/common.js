/* common.js —— 渲染层公共工具（window.UI）
 * 职责：IPC 调用统一封装（统一 toast 错误）、toast、弹层、确认框、
 *       字节/时间格式化、HTML 转义、图标、主题应用、剪贴板、防抖。
 * 经典 script 模式：挂载到 window.UI，供其他页面脚本通过 window 引用。
 */
(function () {
  'use strict';

  var toastRoot = null;

  var ICONS = {
    folder: '📁', image: '🖼', video: '🎬', audio: '🎵', pdf: '📕',
    text: '📄', code: '🧾', archive: '📦', file: '📄', exe: '⚙', sheet: '📊', slides: '📽'
  };

  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstChild;
  }

  var UI = {
    /**
     * 统一 IPC 调用：ok 返回 data；失败统一 toast 错误并返回 null。
     * 渲染层所有 window.wp.invoke 都必须经由此入口（统一错误提示）。
     */
    wp: async function (channel, payload) {
      try {
        var r = await window.wp.invoke(channel, payload || {});
        if (!r || !r.ok) {
          var msg = (r && r.error && (r.error.message || r.error.code)) || '操作失败';
          UI.toast(msg, 'error');
          return null;
        }
        return r.data;
      } catch (e) {
        UI.toast('与主进程通信失败：' + (e.message || e), 'error');
        return null;
      }
    },

    toast: function (msg, type) {
      if (!toastRoot) toastRoot = document.getElementById('toast-root');
      var t = el('<div class="toast ' + (type || 'info') + '"></div>');
      t.textContent = msg;
      toastRoot.appendChild(t);
      setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, 3200);
    },

    escapeHtml: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    formatBytes: function (n) {
      if (n == null || isNaN(n)) return '未知';
      n = Number(n);
      if (n < 1024) return n + ' B';
      var units = ['KB', 'MB', 'GB', 'TB'];
      var i = -1;
      do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
      return n.toFixed(n >= 100 ? 0 : 1) + ' ' + units[i];
    },

    formatSpeed: function (bps) { return UI.formatBytes(bps) + '/s'; },

    formatTime: function (t) {
      if (!t) return '-';
      var d = new Date(t);
      if (isNaN(d.getTime())) return '-';
      var pad = function (x) { return String(x).padStart(2, '0'); };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    },

    icon: function (name) { return ICONS[name] || ICONS.file; },

    /** 按文件名/类型选择图标。 */
    fileIcon: function (file) {
      if (file.is_dir) return ICONS.folder;
      var name = (file.name || '').toLowerCase();
      if (file.mime) {
        if (file.mime.indexOf('image/') === 0) return ICONS.image;
        if (file.mime.indexOf('video/') === 0) return ICONS.video;
        if (file.mime.indexOf('audio/') === 0) return ICONS.audio;
        if (file.mime === 'application/pdf') return ICONS.pdf;
        if (file.mime === 'application/zip' || file.mime.indexOf('compressed') >= 0) return ICONS.archive;
      }
      var ext = name.split('.').pop();
      var map = {
        png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
        mp4: 'video', mkv: 'video', webm: 'video', mov: 'video', avi: 'video',
        mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio',
        pdf: 'pdf',
        txt: 'text', md: 'text', log: 'text', csv: 'text',
        js: 'code', ts: 'code', py: 'code', go: 'code', java: 'code', c: 'code', cpp: 'code', html: 'code', css: 'code', json: 'code', xml: 'code', sh: 'code',
        zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
        xls: 'sheet', xlsx: 'sheet', ppt: 'slides', pptx: 'slides',
        exe: 'exe', msi: 'exe', dmg: 'exe', apk: 'exe', deb: 'exe'
      };
      return ICONS[map[ext] || 'file'];
    },

    /** 彩色文件类型色块（百度网盘风）：返回 {cls, label}，用于文件列表。 */
    fileBadge: function (file) {
      if (file.is_dir) return { cls: 'fb-folder', label: '📁' };
      var name = (file.name || '').toLowerCase();
      var mime = file.mime || '';
      if (mime.indexOf('image/') === 0) return { cls: 'fb-image', label: '图片' };
      if (mime.indexOf('video/') === 0) return { cls: 'fb-video', label: '视频' };
      if (mime.indexOf('audio/') === 0) return { cls: 'fb-audio', label: '音频' };
      if (mime === 'application/pdf') return { cls: 'fb-pdf', label: 'PDF' };
      if (mime === 'application/zip' || mime.indexOf('compressed') >= 0) return { cls: 'fb-archive', label: '压缩' };
      var ext = (name.split('.').pop() || 'file').toUpperCase().slice(0, 4);
      var map = {
        PNG: 'fb-image', JPG: 'fb-image', JPEG: 'fb-image', GIF: 'fb-image', WEBP: 'fb-image', SVG: 'fb-image', BMP: 'fb-image',
        MP4: 'fb-video', MKV: 'fb-video', WEBM: 'fb-video', MOV: 'fb-video', AVI: 'fb-video',
        MP3: 'fb-audio', WAV: 'fb-audio', FLAC: 'fb-audio', OGG: 'fb-audio', M4A: 'fb-audio',
        ZIP: 'fb-archive', RAR: 'fb-archive', '7Z': 'fb-archive', TAR: 'fb-archive', GZ: 'fb-archive',
        XLS: 'fb-sheet', XLSX: 'fb-sheet', CSV: 'fb-sheet',
        PPT: 'fb-slides', PPTX: 'fb-slides',
        DOC: 'fb-doc', DOCX: 'fb-doc', TXT: 'fb-text', MD: 'fb-text', LOG: 'fb-text',
        JS: 'fb-code', TS: 'fb-code', PY: 'fb-code', GO: 'fb-code', JAVA: 'fb-code', JSON: 'fb-code', XML: 'fb-code', HTML: 'fb-code', CSS: 'fb-code',
        EXE: 'fb-exe', MSI: 'fb-exe', APK: 'fb-exe', DMG: 'fb-exe'
      };
      return { cls: map[ext] || 'fb-file', label: ext };
    },

    /** 是否可在线预览（服务端白名单 + 非加密）。 */
    previewable: function (file) {
      if (!file || file.is_dir || file.encrypted) return false;
      var m = file.mime || '';
      return m.indexOf('image/') === 0 || m.indexOf('video/') === 0 || m.indexOf('audio/') === 0 ||
        ['text/plain', 'text/markdown', 'text/csv', 'application/pdf', 'application/json', 'application/xml'].indexOf(m) >= 0;
    },

    /* ---------------- 弹层 ---------------- */
    openModal: function (cfg) {
      var root = document.getElementById('modal-root');
      var mask = el('<div class="modal-mask"></div>');
      var modal = el(
        '<div class="modal ' + (cfg.wide ? 'wide' : '') + '">' +
        '<div class="modal-head"><div class="modal-title"></div><button class="modal-close" type="button">✕</button></div>' +
        '<div class="modal-body"></div>' +
        (cfg.footer !== false ? '<div class="modal-foot"></div>' : '') +
        '</div>'
      );
      modal.querySelector('.modal-title').textContent = cfg.title || '';
      modal.querySelector('.modal-close').addEventListener('click', function () { UI.closeModal(); });
      if (cfg.body) {
        var body = modal.querySelector('.modal-body');
        if (typeof cfg.body === 'string') body.innerHTML = cfg.body;
        else body.appendChild(cfg.body);
      }
      var foot = modal.querySelector('.modal-foot');
      if (foot && cfg.buttons) {
        cfg.buttons.forEach(function (b) {
          var btn = el('<button class="btn ' + (b.cls || '') + '" type="button"></button>');
          btn.textContent = b.label;
          btn.addEventListener('click', function () {
            var keep = b.onClick && b.onClick(modal);
            if (!keep) UI.closeModal();
          });
          foot.appendChild(btn);
        });
      }
      if (cfg.onMount) cfg.onMount(modal);
      mask.appendChild(modal);
      mask.addEventListener('mousedown', function (e) { if (e.target === mask) UI.closeModal(); });
      root.appendChild(mask);
      return modal;
    },

    closeModal: function () {
      var root = document.getElementById('modal-root');
      while (root.firstChild) root.removeChild(root.firstChild);
    },

    /** 确认框：返回 Promise<boolean>。 */
    confirm: function (message, title) {
      return new Promise(function (resolve) {
        UI.openModal({
          title: title || '确认操作',
          body: '<div style="padding:8px 0;line-height:1.7">' + UI.escapeHtml(message) + '</div>',
          buttons: [
            { label: '取消', cls: 'ghost', onClick: function () { resolve(false); } },
            { label: '确定', cls: 'danger', onClick: function () { resolve(true); } }
          ]
        });
      });
    },

    /** 文本输入框：返回 Promise<string|null>。 */
    prompt: function (title, placeholder, initial) {
      return new Promise(function (resolve) {
        var input = el('<input type="text" style="width:100%" />');
        input.placeholder = placeholder || '';
        input.value = initial || '';
        var result = null;
        UI.openModal({
          title: title,
          body: input,
          buttons: [
            { label: '取消', cls: 'ghost', onClick: function () { result = null; } },
            {
              label: '确定', cls: 'primary', onClick: function () {
                var v = input.value.trim();
                if (!v) { UI.toast('内容不能为空', 'warn'); return true; }
                result = v;
              }
            }
          ],
          onMount: function () { setTimeout(function () { input.focus(); input.select(); }, 50); }
        }).addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            var v = input.value.trim();
            if (v) { result = v; UI.closeModal(); }
          }
        });
        // 弹层关闭后 resolve
        var check = setInterval(function () {
          if (!document.querySelector('.modal-mask')) {
            clearInterval(check);
            resolve(result);
          }
        }, 100);
      });
    },

    copyText: function (text) {
      var done = function (okMsg) { UI.toast(okMsg || '已复制到剪贴板', 'ok'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(); }).catch(function () { fallback(); });
      } else fallback();
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          if (document.execCommand('copy')) done();
          else window.wp.invoke('app:copyText', { text: text }).then(function () { done(); });
        } catch (e) {
          window.wp.invoke('app:copyText', { text: text }).then(function () { done(); });
        }
        document.body.removeChild(ta);
      }
    },

    applyTheme: function (theme) {
      document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    },

    debounce: function (fn, ms) {
      var t = null;
      return function () {
        var args = arguments, self = this;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(self, args); }, ms);
      };
    },

    /** 状态中文文案。 */
    statusText: function (task) {
      var map = {
        queued: '排队中', running: '传输中', paused: '已暂停',
        done: '已完成', error: '失败', canceled: '已取消'
      };
      return map[task.status] || task.status;
    },

    /** 相对路径去根目录前缀，用于提示展示。 */
    shortPath: function (p, max) {
      p = String(p || '');
      max = max || 60;
      if (p.length <= max) return p;
      return '…' + p.slice(p.length - max);
    }
  };

  window.UI = UI;
})();
