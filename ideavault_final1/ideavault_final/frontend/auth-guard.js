/**
 * Shared auth + topnav wiring — include BEFORE page-specific script.
 * Requires: data-top-greet, data-top-profile, data-top-logout on the topnav.
 */
(function () {
  var userId = localStorage.getItem('ideavault_userId');
  if (!userId) {
    window.location.href = '/login.html';
    return;
  }

  var API = (window.location.origin && window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:5000') + '/api';

  // Wire topnav
  var prof = document.querySelector('[data-top-profile]');
  if (prof) prof.setAttribute('href', '/profile.html?userId=' + encodeURIComponent(userId));

  function doLogout() {
    localStorage.removeItem('ideavault_userId');
    localStorage.removeItem('ideavault_token');
    window.location.href = '/login.html';
  }
  document.querySelectorAll('[data-top-logout]').forEach(function (btn) {
    btn.addEventListener('click', doLogout);
  });

  // Fetch user + fill greet
  fetch(API + '/user/' + userId)
    .then(function (r) { return r.json(); })
    .then(function (u) {
      if (!u || u.error) return;
      var g = document.querySelector('[data-top-greet]');
      if (g) g.textContent = '\u{1F44B} ' + (u.name || 'Founder');
      window._ivUser = u;
    })
    .catch(function () {});

  // Expose userId globally for page scripts
  window._ivUserId = userId;
})();

// ── Global toast helper ──────────────────────────────────────────────────
window.ivToast = (function () {
  var container = null;
  function ensure() {
    if (!container) {
      container = document.createElement('div');
      container.id = 'iv-toast-container';
      document.body.appendChild(container);
    }
  }
  return function (msg, kind, ms) {
    ensure();
    var t = document.createElement('div');
    t.className = 'iv-toast ' + (kind || 'info');
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      t.style.transition = 'opacity .3s';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 350);
    }, ms || 3000);
  };
})();

// ── Button busy helper ───────────────────────────────────────────────────
window.ivSetBusy = function (btn, busy) {
  if (!btn) return;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (busy) btn.setAttribute('disabled', '');
  else btn.removeAttribute('disabled');
};
