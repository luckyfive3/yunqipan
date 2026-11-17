/* settings.js —— 设置页（window.Settings）
 * 职责：下载/缓存目录、上传下载并发、单文件线程数（1-32）、上下行限速（KB/s）、
 *       aria2 开关与路径（注明可选加速内核）、解析器开关（默认关 + 合规提示）、
 *       E2E 默认加密开关与口令、主题；所有修改即改即存（settings:set）。
 */
(function () {
  'use strict';

  var Settings = {
    init: function () {
      document.getElementById('btn-pick-download-dir').addEventListener('click', Settings.pickDownloadDir);
      // 免登录模式：不再提供退出登录按钮（账号由 auth:autoLogin 自动管理）

      // 即改即存字段：change 事件统一保存
      [
        ['set-theme', 'theme'],
        ['set-max-upload', 'maxUploadTasks', parseInt],
        ['set-max-download', 'maxDownloadTasks', parseInt],
        ['set-threads', 'defaultThreads', parseInt],
        ['set-limit-down', 'limitDownKbps', parseInt],
        ['set-limit-up', 'limitUpKbps', parseInt],
        ['set-chunk', 'uploadChunkSize', function (v) { return parseInt(v, 10) * 1048576; }]
      ].forEach(function (item) {
        document.getElementById(item[0]).addEventListener('change', function () {
          var raw = this.value;
          var v = item[2] ? item[2](raw) : raw;
          Settings.save(item[1], v);
        });
      });

      // 开关与文本
      document.getElementById('set-aria2').addEventListener('change', function () {
        Settings.save('aria2Enabled', this.checked);
      });
      document.getElementById('set-aria2-path').addEventListener('change', function () {
        Settings.save('aria2Path', this.value.trim());
      });
      document.getElementById('set-parser-baidu').addEventListener('change', function () {
        Settings.save('parsers', { baidu: this.checked });
      });
      document.getElementById('set-parser-quark').addEventListener('change', function () {
        Settings.save('parsers', { quark: this.checked });
      });
      document.getElementById('set-e2e').addEventListener('change', function () {
        Settings.save('e2eDefault', this.checked);
      });
      document.getElementById('set-e2e-pass').addEventListener('change', function () {
        var v = this.value.trim();
        if (v) Settings.save('e2ePassphrase', v);
      });
    },

    show: async function () {
      var s = App.state.settings;
      if (!s) { s = await UI.wp('settings:get'); if (s) App.state.settings = s; }
      if (!s) return;
      document.getElementById('set-download-dir').value = s.downloadDir || '';
      document.getElementById('set-cache-dir').value = s.cacheDir || '';
      document.getElementById('set-theme').value = s.theme || 'light';
      document.getElementById('set-max-upload').value = s.maxUploadTasks;
      document.getElementById('set-max-download').value = s.maxDownloadTasks;
      document.getElementById('set-threads').value = s.defaultThreads;
      document.getElementById('set-limit-down').value = s.limitDownKbps;
      document.getElementById('set-limit-up').value = s.limitUpKbps;
      document.getElementById('set-chunk').value = Math.round((s.uploadChunkSize || 8388608) / 1048576);
      document.getElementById('set-aria2').checked = !!s.aria2Enabled;
      document.getElementById('set-aria2-path').value = s.aria2Path || '';
      document.getElementById('set-parser-baidu').checked = !!(s.parsers && s.parsers.baidu);
      document.getElementById('set-parser-quark').checked = !!(s.parsers && s.parsers.quark);
      document.getElementById('set-e2e').checked = !!s.e2eDefault;
      document.getElementById('set-e2e-pass').value = s.e2ePassphrase || '';
    },

    pickDownloadDir: async function () {
      var r = await UI.wp('app:pickDirectory', { title: '选择默认下载目录' });
      if (!r || !r.path) return;
      document.getElementById('set-download-dir').value = r.path;
      Settings.save('downloadDir', r.path);
    },

    save: async function (key, value) {
      var s = await UI.wp('settings:set', { key: key, value: value });
      if (s) {
        App.state.settings = s;
        UI.applyTheme(s.theme);
        document.getElementById('btn-theme').textContent = s.theme === 'dark' ? '☀' : '🌙';
        UI.toast('设置已保存', 'ok');
      }
    }
  };

  window.Settings = Settings;
})();
