/**
 * Loads sidebar.html into #sidebar-container, marks active link,
 * wires logout + mobile overlay + hamburger.
 */
(function () {
  var container = document.getElementById('sidebar-container');
  if (!container) return;

  function currentPage() {
    var path = window.location.pathname || '';
    var parts = path.split('/');
    return parts[parts.length - 1] || 'dashboard.html';
  }

  function setActive() {
    var page = currentPage();
    var links = container.querySelectorAll('.sb-nav a[data-nav]');
    links.forEach(function (a) {
      var target = a.getAttribute('data-nav');
      if (target === page) a.classList.add('is-active');
      else a.classList.remove('is-active');
    });
  }

  function closeSidebar() {
    document.body.classList.remove('iv-sidebar-open');
  }

  function wireChrome() {
    var toggle = document.querySelector('[data-nav-toggle]');
    var overlay = document.querySelector('[data-sidebar-overlay]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        document.body.classList.toggle('iv-sidebar-open');
      });
    }
    if (overlay) overlay.addEventListener('click', closeSidebar);
    container.querySelectorAll('.sb-nav a').forEach(function (a) {
      a.addEventListener('click', function () {
        if (window.innerWidth <= 900) closeSidebar();
      });
    });

    var logoutBtn = container.querySelector('[data-sb-logout]');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        localStorage.removeItem('ideavault_userId');
        localStorage.removeItem('ideavault_token');
        window.location.href = '/login.html';
      });
    }
  }

  function fillUser() {
    var uid = localStorage.getItem('ideavault_userId');
    var nameEl = container.querySelector('[data-sb-name]');
    var imgEl = container.querySelector('[data-sb-avatar]');
    if (!uid || !nameEl) return;

    var API = window.location.origin + '/api';
    fetch(API + '/user/' + uid)
      .then(function (r) {
        return r.json();
      })
      .then(function (u) {
        if (!u || u.error) return;
        nameEl.textContent = u.name || 'User';
        if (u.image && imgEl) {
          imgEl.src = u.image;
          imgEl.hidden = false;
        }
      })
      .catch(function () {});
  }

  fetch('/sidebar.html')
    .then(function (r) {
      return r.text();
    })
    .then(function (html) {
      container.innerHTML = html;
      setActive();
      wireChrome();
      fillUser();
      
      // Start unread notification badge polling
      updateUnreadBadge();
      setInterval(updateUnreadBadge, 4000);
    })
    .catch(function () {
      container.innerHTML = '<aside class="ideavault-sidebar"><p>Sidebar unavailable</p></aside>';
    });

  var lastUnreadCount = null;

  function updateUnreadBadge() {
    var uid = localStorage.getItem('ideavault_userId');
    if (!uid) return;
    var API = window.location.origin + '/api';
    fetch(API + '/notifications/unread-count/' + encodeURIComponent(uid))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && typeof res.count === 'number') {
          var unread = res.count;
          
          // Render badge in sidebar
          var navLink = container.querySelector('a[data-nav="notifications.html"]');
          if (navLink) {
            var existingBadge = navLink.querySelector('.sb-unread-badge');
            if (unread > 0) {
              if (!existingBadge) {
                existingBadge = document.createElement('span');
                existingBadge.className = 'sb-unread-badge';
                existingBadge.style.cssText = 'background: #ef4444; color: #fff; border-radius: 20px; padding: 2px 8px; font-size: 0.72rem; font-weight: 800; margin-left: auto; box-shadow: 0 0 10px rgba(239, 68, 68, 0.4); animation: pulse-ring 2s infinite ease-in-out;';
                navLink.appendChild(existingBadge);
              }
              existingBadge.textContent = unread;
            } else if (existingBadge) {
              existingBadge.remove();
            }
          }

          // Real-time toast alert popover if count goes up!
          if (lastUnreadCount !== null && unread > lastUnreadCount) {
            // Trigger toast alert for the latest notification!
            fetch(API + '/notifications/' + encodeURIComponent(uid), {
              headers: { Authorization: 'Bearer ' + localStorage.getItem('ideavault_token') }
            })
              .then(function (r) { return r.json(); })
              .then(function (items) {
                if (Array.isArray(items) && items.length > 0) {
                  // Get the most recent unread notification
                  var latest = items[0];
                  if (latest && !latest.read) {
                    showRealtimeToast(latest.text);
                  }
                }
              })
              .catch(function () {});
          }
          lastUnreadCount = unread;
        }
      })
      .catch(function () {});
  }

  function showRealtimeToast(text) {
    // Check if toast container exists
    var tContainer = document.getElementById('iv-toast-container');
    if (!tContainer) {
      tContainer = document.createElement('div');
      tContainer.id = 'iv-toast-container';
      tContainer.style.cssText = 'position: fixed; top: 80px; right: 20px; z-index: 99999; display: flex; flex-direction: column; gap: 10px; pointer-events: none; max-width: 360px; width: calc(100% - 40px);';
      document.body.appendChild(tContainer);

      // Inject custom toast keyframes
      var style = document.createElement('style');
      style.textContent = '@keyframes toast-slide { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } } @keyframes pulse-ring { 0% { transform: scale(0.95); opacity: 1; } 50% { transform: scale(1.05); opacity: 0.5; } 100% { transform: scale(0.95); opacity: 1; } }';
      document.head.appendChild(style);
    }

    var toast = document.createElement('div');
    toast.style.cssText = 'pointer-events: auto; background: rgba(30, 41, 59, 0.95); border: 1px solid rgba(99, 102, 241, 0.4); border-left: 5px solid #6366F1; color: #f8fafc; padding: 16px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); display: flex; flex-direction: column; gap: 8px; font-family: "Outfit", sans-serif; cursor: pointer; animation: toast-slide 0.4s cubic-bezier(0.16, 1, 0.3, 1); transition: all 0.3s ease;';
    
    toast.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap: 10px;">
        <span style="font-size:0.75rem; font-weight:800; text-transform:uppercase; color:#818cf8; letter-spacing:0.05em;"><i class="fa-solid fa-bell"></i> New Alert</span>
        <span style="font-size:0.7rem; color:#94a3b8;"><i class="fa-solid fa-xmark"></i></span>
      </div>
      <div style="font-size:0.88rem; font-weight:600; line-height:1.4;">${text}</div>
      <div style="font-size:0.72rem; color:#818cf8; font-weight:700; display:flex; align-items:center; gap:4px; margin-top:2px;">View in notifications tab <i class="fa-solid fa-arrow-right"></i></div>
    `;

    toast.addEventListener('click', function (e) {
      if (e.target.closest('.fa-xmark')) {
        toast.remove();
      } else {
        window.location.href = '/notifications.html';
      }
    });

    tContainer.appendChild(toast);

    // Auto remove after 6 seconds
    setTimeout(function () {
      if (toast.parentNode) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(120%)';
        setTimeout(function () { toast.remove(); }, 300);
      }
    }, 6000);
  }
})();
