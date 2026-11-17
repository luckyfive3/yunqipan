/* auth.js —— 连接页（免登录模式，window.Auth）
 * 职责：显示服务地址与连接状态；本地单用户模式由主进程 auth:autoLogin
 *       自动注册/登录本地账号，本页仅作为「服务端不可达」时的重试界面。
 */
(function () {
  'use strict';

  var Auth = {
    init: function () {
      document.getElementById('connect-retry').addEventListener('click', function () { Auth.retry(); });
      document.getElementById('connect-server').addEventListener('change', function () {
        var v = this.value.trim();
        if (v) window.UI.wp('settings:set', { key: 'serverBase', value: v });
      });
    },

    setStatus: function (text, isErr) {
      var el = document.getElementById('connect-status');
      if (el) {
        el.textContent = text || '';
        el.className = 'login-tip' + (isErr ? ' err' : '');
      }
    },

    /** 显示连接页并预填服务地址。 */
    show: function () {
      if (App.state.settings) {
        document.getElementById('connect-server').value = App.state.settings.serverBase || '';
      }
      document.getElementById('login-view').classList.remove('hidden');
      document.getElementById('app-view').classList.add('hidden');
    },

    hide: function () {
      document.getElementById('login-view').classList.add('hidden');
      document.getElementById('app-view').classList.remove('hidden');
    },

    /** 连接/重试：免登录自动进入。服务地址留空 = 自动使用内置单机服务端。 */
    retry: async function () {
      var server = document.getElementById('connect-server').value.trim();
      if (server && !/^https?:\/\//i.test(server)) {
        Auth.setStatus('服务地址需以 http:// 或 https:// 开头', true);
        return;
      }
      if (App.state.settings && App.state.settings.serverBase !== server) {
        await UI.wp('settings:set', { key: 'serverBase', value: server });
      }
      Auth.setStatus('正在连接云栖盘…');
      var u = await UI.wp('auth:autoLogin');
      if (u) {
        App.state.authed = true;
        App.state.user = u.user;
        Auth.hide();
        App.enterApp();
      } else {
        Auth.setStatus('连接失败：请确认服务端已启动（双击 start.bat），然后重试。', true);
      }
    }
  };

  window.Auth = Auth;
})();
