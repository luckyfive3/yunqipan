/* app.js —— 应用壳（window.App）
 * 职责：启动引导（读取全局状态 → 决定登录/主界面）、页面导航、
 *       全局事件订阅（认证变化）、主题应用、登出、顶栏头像下拉菜单。
 * 各页面对象约定实现 init() 与 show()，互相之间通过 window 引用。
 */
(function () {
  'use strict';

  var App = {
    state: { authed: false, user: null, settings: null, version: '', page: 'files' },
    pages: { files: 'Files', transfers: 'Transfers', shares: 'Shares', sync: 'Sync', settings: 'Settings' },

    init: async function () {
      // 各页面初始化
      Auth.init();
      Files.init();
      Preview.init();
      Transfers.init();
      Shares.init();
      Sync.init();
      Settings.init();
      Parse.init();

      // 导航
      document.querySelectorAll('#sidebar nav .nav-item').forEach(function (b) {
        b.addEventListener('click', function () { App.showPage(b.dataset.page); });
      });

      // 顶栏头像下拉菜单
      var menu = document.getElementById('user-menu');
      document.getElementById('avatar-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        menu.classList.toggle('hidden');
      });
      document.addEventListener('click', function (e) {
        if (menu && !menu.classList.contains('hidden') && !e.target.closest('.avatar-wrap')) {
          menu.classList.add('hidden');
        }
      });
      document.getElementById('menu-theme').addEventListener('click', function () {
        menu.classList.add('hidden');
        Files.toggleTheme();
      });
      document.getElementById('menu-settings').addEventListener('click', function () {
        menu.classList.add('hidden');
        App.showPage('settings');
      });
      document.getElementById('menu-quota').addEventListener('click', function () {
        menu.classList.add('hidden');
        App.showPage('files');
      });

      // 认证变化：过期/登出 → 回登录页
      window.wp.on('auth:changed', function (p) {
        if (p && p.authed === false) {
          App.state.authed = false;
          App.state.user = null;
          if (p.reason === 'expired') UI.toast('登录已过期，请重新登录', 'warn');
          Auth.show();
        }
      });

      var st = await UI.wp('app:getState');
      if (!st) { Auth.show(); return; }
      App.state.settings = st.settings;
      App.state.version = st.version;
      UI.applyTheme(st.settings.theme);
      if (st.authed) {
        App.state.authed = true;
        App.state.user = st.user;
        Auth.hide();
        App.enterApp();
      } else {
        // 免登录模式：自动注册/登录本地账号，成功后直接进入主界面
        var u = await UI.wp('auth:autoLogin');
        if (u) {
          App.state.authed = true;
          App.state.user = u.user;
          Auth.hide();
          App.enterApp();
        } else {
          Auth.show();
        }
      }
    },

    enterApp: function () {
      var username = App.state.user ? App.state.user.username : '未登录';
      document.getElementById('user-name').textContent = username;
      var letter = App.state.user ? username.charAt(0).toUpperCase() : '未';
      document.getElementById('avatar-letter').textContent = letter;
      document.getElementById('menu-user').textContent = username;
      var theme = App.state.settings && App.state.settings.theme === 'dark' ? '☀ 切换主题' : '🌙 切换主题';
      document.getElementById('menu-theme').textContent = theme;
      App.showPage('files');
    },

    showPage: function (name) {
      App.state.page = name;
      document.querySelectorAll('#sidebar nav .nav-item').forEach(function (b) {
        b.classList.toggle('active', b.dataset.page === name);
      });
      document.querySelectorAll('.page').forEach(function (s) {
        s.classList.toggle('hidden', s.id !== 'page-' + name);
      });
      var fn = App.pages[name];
      if (fn && window[fn] && typeof window[fn].show === 'function') window[fn].show();
    },

    /** 设置变更后刷新全局缓存（各页面自行读取）。 */
    refreshSettings: async function () {
      var s = await UI.wp('settings:get');
      if (s) { App.state.settings = s; UI.applyTheme(s.theme); }
    },

    logout: async function () {
      var yes = await UI.confirm('确定退出登录吗？未完成的任务会保留。');
      if (!yes) return;
      await UI.wp('auth:logout');
      App.state.authed = false;
      App.state.user = null;
      document.getElementById('avatar-letter').textContent = '未';
      document.getElementById('menu-user').textContent = '未登录';
      document.getElementById('menu-quota').textContent = '配额：-';
      Auth.show();
    }
  };

  window.App = App;
})();
