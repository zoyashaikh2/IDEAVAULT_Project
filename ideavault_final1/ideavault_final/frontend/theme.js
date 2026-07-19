(function () {
  var key = 'theme';
  var t = localStorage.getItem(key) || 'light';
  document.documentElement.setAttribute('data-theme', t);

  window.ivTheme = {
    get: function () {
      return localStorage.getItem(key) || 'light';
    },
    set: function (mode) {
      var m = mode === 'dark' ? 'dark' : 'light';
      localStorage.setItem(key, m);
      document.documentElement.setAttribute('data-theme', m);
      return m;
    },
    toggle: function () {
      return this.get() === 'dark' ? this.set('light') : this.set('dark');
    },
  };

  function bindToggle() {
    var btn = document.querySelector('[data-theme-toggle]');
    if (!btn) return;
    function syncIcon() {
      var dark = window.ivTheme.get() === 'dark';
      btn.innerHTML = dark
        ? '<i class="fa-solid fa-sun" title="Light mode"></i>'
        : '<i class="fa-solid fa-moon" title="Dark mode"></i>';
    }
    syncIcon();
    btn.addEventListener('click', function () {
      window.ivTheme.toggle();
      syncIcon();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindToggle);
  } else {
    bindToggle();
  }
})();
