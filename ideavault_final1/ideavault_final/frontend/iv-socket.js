/**
 * Socket.io client — live refresh after likes, comments, views.
 * Pages must load socket.io CDN before this file.
 * Connects to the current page origin — no hardcoded port needed.
 */
(function () {
  if (typeof io === 'undefined') return;
  var origin = window.location && window.location.origin ? window.location.origin : '';
  if (!origin) return;

  // Debounce helper — fires fn at most once per `wait` ms
  function debounce(fn, wait) {
    var t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, wait);
    };
  }

  // Debounced full-page refresh (used to update totals, analytics charts, etc.)
  var debouncedRefresh = debounce(function () {
    document.dispatchEvent(new CustomEvent('ideavault:refresh', { detail: { ts: Date.now() } }));
  }, 800);

  try {
    var socket = io(origin, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 3,
      timeout: 5000,
    });

    socket.on('connect', function () {
      var uid = localStorage.getItem('ideavault_userId');
      if (uid) socket.emit('subscribe:user', uid);
    });

    socket.on('connect_error', function () {
      // Silently ignore — live updates are optional enhancement
    });

    socket.on('iv:refresh', function () {
      document.dispatchEvent(new CustomEvent('ideavault:refresh', { detail: { ts: Date.now() } }));
    });

    socket.on('iv:notify', function (payload) {
      document.dispatchEvent(new CustomEvent('ideavault:notify', { detail: payload || {} }));
    });

    /**
     * iv:idea:stats — surgically update every IdeaCard matching ideaId:
     *   1. Engagement row (👁 views ♥ likes 💬 comments)
     *   2. Sparkline "7d Views" header number
     *   3. Sparkline Chart.js — increment today's bar
     *   4. Dashboard spotlight stats
     *   5. Debounced full ideavault:refresh → reloads dashboard totals & analytics charts
     */
    socket.on('iv:idea:stats', function (payload) {
      if (!payload || !payload.ideaId) return;

      // ── 1. Update all IdeaCard elements matching this idea ─────────────────
      var cards = document.querySelectorAll('[data-idea-id="' + payload.ideaId + '"]');
      cards.forEach(function (card) {

        // Engagement row: 👁 views ♥ likes 💬 comments
        var engRow = card.querySelector('.iv-card-engagement-row');
        if (engRow) {
          engRow.querySelectorAll('span').forEach(function (span) {
            if (span.querySelector('.fa-eye')) {
              span.innerHTML = '<i class="fa-solid fa-eye"></i> ' + payload.views;
            } else if (span.querySelector('.fa-heart')) {
              span.innerHTML = '<i class="fa-solid fa-heart"></i> ' + payload.likes;
            } else if (span.querySelector('.fa-comment')) {
              span.innerHTML = '<i class="fa-solid fa-comment"></i> ' + payload.comments;
            }
          });
        }

        // Sparkline header number ("7d Views — 57")
        var sparkVal = card.querySelector('.iv-sparkline-val');
        if (sparkVal) sparkVal.textContent = payload.views;

        // Sparkline Chart.js canvas — increment today's data point (index 6 = today)
        var sparkCanvas = document.getElementById('spark-chart-' + payload.ideaId);
        if (sparkCanvas && typeof Chart !== 'undefined') {
          try {
            var chart = Chart.getChart ? Chart.getChart(sparkCanvas) : null;
            if (chart && chart.data && chart.data.datasets && chart.data.datasets[0]) {
              var data = chart.data.datasets[0].data;
              if (data && data.length > 0) {
                // Today is always the last slot
                data[data.length - 1] = (data[data.length - 1] || 0) + 1;
                chart.update('none'); // instant, no animation
              }
            }
          } catch (_) { /* noop */ }
        }

        // Pulse glow on the card to signal live update
        card.style.transition = 'box-shadow 0.3s ease';
        card.style.boxShadow = '0 0 0 2px rgba(99,102,241,0.55)';
        setTimeout(function () { card.style.boxShadow = ''; }, 700);
      });

      // ── 2. Dashboard spotlight (rendered outside a card article) ───────────
      var spot = document.querySelector('[data-spotlight]');
      if (spot && spot.getAttribute('data-spotlight-idea-id') === payload.ideaId) {
        spot.querySelectorAll('.dash-spot-stats span').forEach(function (span) {
          if (span.querySelector('.fa-eye')) {
            span.innerHTML = '<i class="fa-solid fa-eye"></i> ' + payload.views + ' views';
          } else if (span.querySelector('.fa-heart')) {
            span.innerHTML = '<i class="fa-solid fa-heart" style="color:#ef4444"></i> ' + payload.likes;
          } else if (span.querySelector('.fa-comment')) {
            span.innerHTML = '<i class="fa-solid fa-comment" style="color:var(--accent)"></i> ' + payload.comments;
          }
        });
      }

      // ── 3. Dashboard summary bar (Total Likes / Views / Comments) ──────────
      // These elements are rendered by dashboard.js loadAll() — trigger a debounced
      // reload so the totals, engagement rate, conversion %, and analytics charts
      // all update without requiring a manual page refresh.
      debouncedRefresh();
    });

  } catch (e) {
    // Socket is optional — swallow errors silently
  }
})();
