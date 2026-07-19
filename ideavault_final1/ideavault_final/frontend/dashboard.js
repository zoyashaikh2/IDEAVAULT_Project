const API = (window.location.origin && window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:5000') + '/api';

(function () {
  // auth guard + userId provided by auth-guard.js
  var userId = window._ivUserId || localStorage.getItem('ideavault_userId');
  if (!userId) { window.location.href = '/login.html'; return; }

  window.__ivToast = function (msg) {
    var el = document.getElementById('iv-toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(window.__ivToastTimer);
    window.__ivToastTimer = setTimeout(function () {
      el.hidden = true;
    }, 7000);
  };
  if (window.ivFetchMoneyConfig) {
    window.ivFetchMoneyConfig(API);
  }

  var state = { user: null, stats: null, weekly: null, ideas: [] };

  function escapeHtml(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function formatTags(idea) {
    var t = idea.tags;
    if (!t) return '';
    if (Array.isArray(t)) return t.slice(0, 4).join(', ');
    return String(t).slice(0, 80);
  }

  function countUp(el, target, duration) {
    var start = 0;
    var t0 = performance.now();
    function frame(now) {
      var p = Math.min(1, (now - t0) / duration);
      var val = Math.round(start + (target - start) * p);
      el.textContent = String(val);
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function healthFromIdeas(published, stats) {
    var invSum = 0;
    var invN = 0;
    var vcSum = 0;
    var vcN = 0;
    published.forEach(function (i) {
      var a = i.aiAnalysis;
      if (a && typeof a.innovationScore === 'number') {
        invSum += a.innovationScore;
        invN++;
      }
      if (a && typeof a.vcFitScore === 'number') {
        vcSum += a.vcFitScore;
        vcN++;
      }
    });
    var invHasAi = invN > 0;
    var invAvg = invN ? invSum / invN : null;
    var vcAvg = vcN ? vcSum / vcN : null;
    var eng = stats && stats.engagementRate ? stats.engagementRate : 0;
    var pubCount = published.length;
    var tl = stats && stats.totalLikes != null ? stats.totalLikes : 0;
    var tc = stats && stats.totalComments != null ? stats.totalComments : 0;
    if (invAvg == null) invAvg = 0;
    if (vcAvg == null) vcAvg = 0;
    
    var marketDemandPct = invHasAi
      ? Math.min(100, Math.round((invSum / invN) * 10))
      : 0; // Don't use fake proxy demand
      
    var raw = invAvg * 5 + vcAvg * 0.35 + eng * 0.45;
    var score = Math.max(0, Math.min(100, Math.round(raw)));
    var label = 'Emerging Potential';
    if (score >= 82) label = 'Strong Early Potential';
    else if (score >= 68) label = 'Solid Momentum';
    else if (score >= 52) label = 'Room to Accelerate';
    if (!pubCount) {
      label = 'Getting started';
      score = Math.min(score, 42);
    }
    return {
      score: score,
      label: label,
      invAvg: invAvg,
      vcAvg: vcAvg,
      eng: eng,
      marketDemandPct: marketDemandPct,
      invHasAi: invHasAi,
      pubCount: pubCount,
    };
  }

  function setRing(percent) {
    var ring = document.querySelector('[data-health-ring]');
    if (!ring) return;
    var c = 2 * Math.PI * 52;
    var off = c * (1 - percent / 100);
    ring.style.strokeDasharray = String(c);
    ring.style.strokeDashoffset = String(off);
  }

  function trendInsight(counts) {
    if (!counts || !counts.length) return 'Add published ideas and share them to start seeing reach.';
    var last = counts[counts.length - 1] || 0;
    var first = counts[0] || 0;
    var diff = last - first;
    var pct = first > 0 ? Math.round((diff / first) * 100) : 0;
    var sign = diff >= 0 ? '+' : '';
    
    if (diff > 0) return 'Reach is trending up: ' + first + ' → ' + last + ' (' + sign + pct + '%) this week. Keep publishing and engaging!';
    if (diff < 0) return 'Reach dipped: ' + first + ' → ' + last + ' (' + diff + ') views. Try refreshing a top idea or asking peers for feedback.';
    return 'Reach is steady at ' + last + ' daily views. Experiment with a new category to boost discovery.';
  }


  function renderFactors(h) {
    var tb = document.querySelector('[data-health-factors]');
    if (!tb) return;
    var md =
      (h.invHasAi ? 'AI innovation avg → ' : 'Engagement-based demand → ') + Math.round(h.marketDemandPct) + '%';
    var rows = [
      ['Market demand signal', h.invHasAi ? Math.round(h.marketDemandPct) + '%' : 'Pending AI'],
      ['Investor fit (from AI on ideas)', h.invHasAi ? Math.round(h.vcAvg) + '/100' : 'Pending AI'],
      ['Engagement (likes+comments / views)', Math.round(h.eng) + '%'],
      ['Innovation (AI)', h.invHasAi ? h.invAvg.toFixed(1) + '/10' : 'Pending AI'],
    ];
    tb.innerHTML = rows
      .map(function (r) {
        return '<tr><td>' + escapeHtml(r[0]) + '</td><td>' + escapeHtml(r[1]) + '</td></tr>';
      })
      .join('');
  }

  function sumLast7dViews(idea) {
    var sum = 0;
    for (var d = 6; d >= 0; d--) {
      var dt = new Date();
      dt.setUTCDate(dt.getUTCDate() - d);
      dt.setUTCHours(0, 0, 0, 0);
      var key = dt.toISOString().slice(0, 10);
      var vh = idea.viewsHistory || [];
      for (var hi = 0; hi < vh.length; hi++) {
        var h = vh[hi];
        if (new Date(h.date).toISOString().slice(0, 10) === key) sum += h.count || 0;
      }
    }
    return sum;
  }

  function spotlightScore(i) {
    var likes = (i.likes && i.likes.length) || 0;
    var comments = (i.comments && i.comments.length) || 0;
    var views = i.views || 0;
    var w7 = sumLast7dViews(i);
    var comp = i.compositeScore != null ? i.compositeScore : 0;
    var hot = i.mlPack && typeof i.mlPack.hotRankScore === 'number' ? i.mlPack.hotRankScore : 0;
    return (
      likes * 14 +
      comments * 28 +
      views * 0.42 +
      w7 * 3.5 +
      comp * 0.18 +
      hot * 0.12
    );
  }

  function renderIdeaCard(idea, opts) {
    return IdeaVaultCard.render(idea, opts);
  }

  function checkAuthenticity(id) {
    if (typeof window.IdeaVaultStrategic !== 'undefined' && window.IdeaVaultStrategic.checkAuthenticity) {
      window.IdeaVaultStrategic.checkAuthenticity(id);
    } else {
      __ivToast('Authenticity module loading...');
    }
  }

  function downloadReport(id) {
    window.open(API + '/reports/pdf/' + id, '_blank');
  }

  function wireIdeaGrid(root) {
    root.querySelectorAll('[data-strat-open]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openStratPopup({ _id: btn.getAttribute('data-strat-open') });
      });
    });
    root.querySelectorAll('[data-read]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openIdeaPopup(btn.getAttribute('data-read'));
      });
    });
    root.querySelectorAll('[data-like]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleLike(btn);
      });
    });
    root.querySelectorAll('[data-idea-id]').forEach(function (article) {
      var id = article.getAttribute('data-idea-id');
      var idea = (state.ideas || []).find(function (i) {
        return String(i._id) === String(id);
      });
      if (idea && window.IdeaVaultCard && IdeaVaultCard.initSparkline) {
        IdeaVaultCard.initSparkline(id, idea.viewsHistory || []);
      }
    });
    root.querySelectorAll('[data-build-similar-id]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var bid = btn.getAttribute('data-build-similar-id');
        if (window.IdeaVaultContact && IdeaVaultContact.runBuildSimilarById) {
          IdeaVaultContact.runBuildSimilarById(bid);
        }
      });
    });
    if (window.IdeaVaultContact && IdeaVaultContact.wireContactButtons) {
      IdeaVaultContact.wireContactButtons(root);
    }
  }

  function toggleLike(btn) {
    var id = btn.getAttribute('data-like');
    fetch(API + '/ideas/' + id + '/like', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d.error) return;
        btn.classList.toggle('liked', d.liked);
        var span = btn.querySelector('.iv-like-count');
        if (span) span.textContent = String(d.count);
      })
      .catch(function () {});
  }

  function openIdeaPopup(id) {
    if (!id) return;
    fetch(API + '/ideas/' + id)
      .then(function (r) {
        return r.json();
      })
      .then(function (idea) {
        if (idea.error) return;
        var body = document.getElementById('idea-popup-body');
        var sent = idea.aiSentiment && idea.aiSentiment.overall;
        var imgBg =
          idea.image && String(idea.image).indexOf('data:') === 0
            ? '<img src="' + escapeHtml(idea.image) + '" alt="" />'
            : '';
        var uid = idea.userId ? String(idea.userId) : '';
        var strip =
          window.IdeaVaultStrategic && IdeaVaultStrategic.analysisStripHtml
            ? IdeaVaultStrategic.analysisStripHtml(idea)
            : '';
        var last7 = [];
        var last7Labels = [];
        var viewsHist = idea.viewsHistory || [];
        for (var di = 6; di >= 0; di--) {
          var dt = new Date();
          dt.setUTCDate(dt.getUTCDate() - di);
          var dk = dt.toISOString().slice(0, 10);
          last7Labels.push(dk.slice(5)); // MM-DD
          var hit = viewsHist.find(function(h) { return new Date(h.date).toISOString().slice(0, 10) === dk; });
          last7.push(hit ? (hit.count || 0) : 0);
        }
        var chartId = 'trend-' + String(idea._id).slice(-6);
        var spark = '<div style="margin:16px 0 10px;padding:10px;border-radius:14px;border:1px solid var(--border);background:rgba(99,102,241,0.04)"><div style="font-size:0.78rem;color:var(--muted);font-weight:600;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px">📈 Daily Views — Last 7 Days</div><canvas id="' + chartId + '" height="80"></canvas></div>';
        body.innerHTML =
          strip +
          '<div class="idea-popup-hero">' +
          imgBg +
          '<h3 id="idea-popup-title">' +
          escapeHtml(idea.title || '') +
          '</h3></div>' +
          '<div class="idea-popup-pills">' +
          '<span class="iv-pill">' +
          escapeHtml(idea.category || '') +
          '</span>' +
          '<span class="iv-pill">' +
          escapeHtml(sent || 'Sentiment n/a') +
          '</span>' +
          (uid
            ? '<a class="iv-pill" href="/profile.html?userId=' +
              escapeHtml(uid) +
              '">Creator</a>'
            : '') +
          '</div>' +
          '<div class="idea-grad-summary">' +
          escapeHtml(idea.aiSummary || idea.summary || 'No AI summary yet.') +
          '</div>' +
          '<div class="idea-two-col">' +
          '<div class="idea-col prob"><strong>Problem</strong><p style="margin:8px 0 0">' +
          escapeHtml(idea.problem || '') +
          '</p></div>' +
          '<div class="idea-col sol"><strong>Solution</strong><p style="margin:8px 0 0">' +
          escapeHtml(idea.solution || '') +
          '</p></div></div>' +
          spark +
          '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;font-size:0.85rem;text-align:center">' +
          '<div class="card" style="padding:10px">Likes<br /><strong>' +
          (idea.likes ? idea.likes.length : 0) +
          '</strong></div>' +
          '<div class="card" style="padding:10px">Comments<br /><strong>' +
          (idea.comments ? idea.comments.length : 0) +
          '</strong></div>' +
          '<div class="card" style="padding:10px">Innovation<br /><strong>' +
          (idea.aiAnalysis && idea.aiAnalysis.innovationScore != null
            ? idea.aiAnalysis.innovationScore
            : '—') +
          '</strong></div>' +
          '<div class="card" style="padding:10px">Views<br /><strong>' +
          (idea.views || 0) +
          '</strong></div></div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">' +
          '<button type="button" class="iv-like' +
          (idea.likes && idea.likes.some(function (x) {
            return String(x) === String(userId);
          })
            ? ' liked'
            : '') +
          '" data-like="' +
          id +
          '"><svg viewBox="0 0 24 24"><path d="M12 21s-6.716-4.576-9-8.5C.5 8.5 2 5 6 5c2.5 0 4.5 2 6 3.5C13.5 7 15.5 5 18 5c4 0 5.5 3.5 4 7.5-2.284 3.924-9 8.5-9 8.5z"/></svg> <span class="iv-like-count">' +
          (idea.likes ? idea.likes.length : 0) +
          '</span></button>' +
          '<button type="button" class="iv-btn iv-btn-sm" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;border:none;box-shadow:0 4px 15px rgba(99,102,241,0.4)" data-open-strat="' +
          id +
          '">Strategic Analytics</button>' +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-bottom:16px">' +
          '<button type="button" class="iv-btn iv-btn-secondary iv-btn-sm" id="btn-contact-creator-' +
          id +
          '"><i class="fa-solid fa-address-card"></i> Contact creator</button>' +
          '</div>' +
          (idea.referenceLink ? '<a class="iv-btn iv-btn-ghost iv-btn-sm" href="' + escapeHtml(idea.referenceLink) + '"><i class="fa-solid fa-link"></i> Reference</a>' : '') +
          '</div>' +
          '<p data-vc-teaser style="font-size:0.82rem;color:var(--muted);margin:10px 0 0;line-height:1.45"></p>' +
          '<h4 style="margin:16px 0 8px">Community Feedback</h4>' +
          '<ul style="list-style:none;padding:0;margin:0 0 12px;font-size:0.9rem;color:var(--muted)">' +
          (idea.comments && idea.comments.length
            ? idea.comments
                .map(function (c) {
                  return (
                    '<li style="padding:8px 0;border-bottom:1px solid var(--border)"><strong>' +
                    escapeHtml(c.user || 'User') +
                    '</strong> · ' +
                    escapeHtml(new Date(c.timestamp).toLocaleString()) +
                    '<br />' +
                    escapeHtml(c.text) +
                    '</li>'
                  );
                })
                .join('')
            : '<li>No comments yet.</li>') +
          '</ul>' +
          '<div style="display:flex;gap:8px;margin-bottom:12px">' +
          '<input class="iv-input" style="flex:1" placeholder="Add a comment" data-comment-text />' +
          '<button type="button" class="iv-btn iv-btn-primary iv-btn-sm" data-post-comment="' +
          id +
          '">Post</button></div>' +
          '<h4 style="margin:16px 0 8px">Rate &amp; Feedback</h4>' +
          '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">' +
          '<label>Rating <select data-fb-rating class="iv-input" style="width:auto"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select></label></div>' +
          '<textarea class="iv-input" rows="2" placeholder="Private feedback to creator" data-fb-text></textarea>' +
          '<button type="button" class="iv-btn iv-btn-secondary iv-btn-sm" style="margin-top:8px" data-send-fb="' +
          id +
          '">Submit feedback</button>';

        document.getElementById('popup-idea').classList.add('is-open');

        // Dynamic chart - render after DOM is updated
        setTimeout(function() {
          var canvas = document.getElementById(chartId);
          if (canvas && typeof Chart !== 'undefined') {
            var totalViews = last7.reduce(function(a,b){return a+b;},0);
            var maxV = Math.max.apply(null, last7) || 1;
            new Chart(canvas.getContext('2d'), {
              type: 'bar',
              data: {
                labels: last7Labels,
                datasets: [{
                  label: 'Views',
                  data: last7,
                  backgroundColor: last7.map(function(v) {
                    var a = 0.4 + 0.6 * (v / maxV);
                    return 'rgba(99,102,241,' + a + ')';
                  }),
                  borderRadius: 6,
                  borderSkipped: false,
                }]
              },
              options: {
                responsive: true,
                plugins: {
                  legend: { display: false },
                  tooltip: {
                    callbacks: {
                      afterBody: function() { return 'Total 7d: ' + totalViews + ' views'; }
                    }
                  }
                },
                scales: {
                  y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: 'rgba(148,163,184,0.15)' } },
                  x: { grid: { display: false }, ticks: { font: { size: 10 } } }
                }
              }
            });
          }
        }, 50);

        var contactBtn = body.querySelector('#btn-contact-creator-' + id);
        if (contactBtn && window.IdeaVaultContact) {
          contactBtn.addEventListener('click', function () {
            function go() {
              IdeaVaultContact.openFromIdea(idea);
            }
            if (idea.userId && !idea.email && !idea.phone) {
              fetch(API + '/user/' + encodeURIComponent(idea.userId))
                .then(function (r) {
                  return r.json();
                })
                .then(function (u) {
                  if (u && !u.error) {
                    idea.email = idea.email || u.email;
                    idea.phone = idea.phone || u.phone;
                    idea.name = idea.name || u.name;
                  }
                  go();
                })
                .catch(go);
            } else {
              go();
            }
          });
        }

        body.querySelector('[data-post-comment]').addEventListener('click', function () {
          var inp = body.querySelector('[data-comment-text]');
          var txt = inp && inp.value.trim();
          if (!txt) return;
          fetch(API + '/ideas/' + id + '/comment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: userId,
              user: state.user && state.user.name,
              text: txt,
            }),
          })
            .then(function (r) {
              return r.json();
            })
            .then(function () {
              inp.value = '';
              openIdeaPopup(id);
            });
        });

        body.querySelector('[data-send-fb]').addEventListener('click', function () {
          var rt = body.querySelector('[data-fb-rating]');
          var tx = body.querySelector('[data-fb-text]');
          var btn = this;
          btn.disabled = true;
          btn.textContent = 'Sending...';

          fetch(API + '/ideas/' + id + '/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: userId,
              userName: (state.user && state.user.name) || 'User',
              text: tx.value.trim(),
              rating: Number(rt.value),
            }),
          })
            .then(function (r) {
              return r.json();
            })
            .then(function (d) {
              btn.disabled = false;
              btn.textContent = 'Submit feedback';
              if (!d.error) {
                tx.value = '';
                if (window.ivToast) ivToast('✅ Feedback sent to creator!', 'success', 3500);
              } else {
                if (window.ivToast) ivToast('Error: ' + d.error, 'error', 4000);
              }
            })
            .catch(function() {
              btn.disabled = false;
              btn.textContent = 'Submit feedback';
            });
        });

        var lp = body.querySelector('[data-like]');
        if (lp)
          lp.addEventListener('click', function () {
            toggleLike(lp);
          });

        body.querySelector('[data-open-strat]').addEventListener('click', function () {
          openStratPopup(idea);
        });

        if (idea.userId) {
          fetch(API + '/user/' + encodeURIComponent(idea.userId))
            .then(function (r) {
              return r.json();
            })
            .then(function (u) {
              if (!u || u.error) return;
              idea.phone = idea.phone || u.phone;
              idea.email = idea.email || u.email;
              idea.name = idea.name || u.name;
            })
            .catch(function () {});
        }

        fetch(API + '/ai/vc-match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ideaId: id }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (d) {
            var el = body.querySelector('[data-vc-teaser]');
            if (!el || !d.matches || !d.matches.length) return;
            var top = d.matches[0];
            var nm = top.investor && top.investor.name ? top.investor.name : 'Investor';
            el.textContent =
              'VC signal: top rule-based match is ' + nm + ' at ~' + Math.round(top.score || 0) + '% fit (see Investors page to contact).';
          })
          .catch(function () {});
      });
  }

  function openStratPopup(idea) {
    var id = String(idea && idea._id ? idea._id : idea);
    var tok = localStorage.getItem('ideavault_token') || '';

    function renderStratPopup(ix) {
      if (!window.IdeaVaultStrategic) {
        if (window.ivToast) ivToast('Strategic module not loaded — refresh the page.', 'error');
        return;
      }
      var left = document.querySelector('[data-strat-left]');
      var right = document.querySelector('[data-strat-right]');
      document.querySelector('[data-strat-title]').textContent = ix.title || 'Analytics';
      left.innerHTML = IdeaVaultStrategic.stratLeftHtml(ix);
      right.innerHTML = IdeaVaultStrategic.stratRightHtml(ix);
      if (window.IdeaVaultContact && IdeaVaultContact.wireContactButtons) {
        IdeaVaultContact.wireContactButtons(left);
      }
      var cp = document.getElementById('btn-creator-pack');
      if (cp) {
        var isOwner = String(ix.userId) === String(userId);
        cp.hidden = !isOwner;
        cp.onclick = function () {
          fetch(API + '/ideas/' + encodeURIComponent(id) + '/creator-pack', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + tok },
          })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d.error) {
                if (window.ivToast) ivToast('Error: ' + d.error, 'error');
                return;
              }
              var w = window.open('', '_blank');
              if (w) { w.document.write(d.html); w.document.close(); }
            })
            .catch(function () {
              if (window.ivToast) ivToast('Could not generate creator pack.', 'error');
            });
        };
      }
      document.getElementById('popup-strat').classList.add('is-open');
    }

    function triggerAiAndRefresh(ix) {
      var hasAnalysis = ix.aiAnalysis && ix.aiAnalysis.innovationScore != null;
      var hasRoadmap = ix.aiRoadmap && (ix.aiRoadmap.phases || []).length > 0;
      if (hasAnalysis && hasRoadmap) {
        renderStratPopup(ix);
        return;
      }
      // Show popup immediately with what we have, then refresh after AI
      renderStratPopup(ix);
      var left = document.querySelector('[data-strat-left]');
      if (left && !hasAnalysis) {
        var banner = document.createElement('div');
        banner.style.cssText = 'background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:12px 16px;margin-bottom:14px;font-size:0.85rem;color:var(--text)';
        banner.innerHTML = '<i class="fa-solid fa-robot" style="color:#6366f1"></i> <strong>Running AI analysis…</strong> Scores will appear in a moment.';
        left.insertBefore(banner, left.firstChild);
      }
      var aiCalls = [];
      if (!hasAnalysis) {
        aiCalls.push(
          fetch(API + '/ai/analysis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
            body: JSON.stringify({ ideaId: id }),
          }).then(function(r) { return r.json(); }).catch(function() { return null; })
        );
      }
      if (!hasRoadmap) {
        aiCalls.push(
          fetch(API + '/ai/roadmap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
            body: JSON.stringify({ ideaId: id }),
          }).then(function(r) { return r.json(); }).catch(function() { return null; })
        );
      }
      Promise.all(aiCalls).then(function() {
        // Re-fetch with fresh AI data
        return fetch(API + '/ideas/' + encodeURIComponent(id) + '?noView=1').then(function(r){ return r.json(); });
      }).then(function(fresh) {
        if (fresh && !fresh.error) {
          renderStratPopup(fresh);
          if (window.ivToast) ivToast('✅ AI analysis complete!', 'success', 3000);
        }
      }).catch(function() {});
    }

    fetch(API + '/ideas/' + encodeURIComponent(id) + '?noView=1')
      .then(function (r) { return r.json(); })
      .then(function (fresh) {
        var ix = fresh && !fresh.error ? fresh : idea;
        triggerAiAndRefresh(ix);
      })
      .catch(function () {
        if (window.ivToast) ivToast('Could not load strategic data.', 'error');
      });
  }

  function closePopups() {
    document.getElementById('popup-idea').classList.remove('is-open');
    document.getElementById('popup-strat').classList.remove('is-open');
  }

  document.querySelector('[data-close-idea]').addEventListener('click', closePopups);
  document.querySelector('[data-close-strat]').addEventListener('click', function () {
    document.getElementById('popup-strat').classList.remove('is-open');
  });
  document.getElementById('popup-idea').addEventListener('click', function (e) {
    if (e.target.id === 'popup-idea') closePopups();
  });
  document.querySelector('[data-print-strat]').addEventListener('click', function () {
    const title = document.querySelector('[data-strat-title]').textContent || 'Report';
    document.title = 'IdeaVault Strategic Report - ' + title;
    window.print();
    setTimeout(() => { document.title = 'Analytics — IdeaVault'; }, 1000);
  });

  // topnav auth/profile wiring is handled by auth-guard.js

  function loadAll() {
    Promise.all([
      window._ivUser
        ? Promise.resolve(window._ivUser)
        : fetch(API + '/user/' + userId).then(function (r) { return r.json(); }),
      fetch(API + '/dashboard/stats/' + userId).then(function (r) { return r.json(); }),
      fetch(API + '/dashboard/weekly/' + userId).then(function (r) { return r.json(); }),
      fetch(API + '/ideas?dashboard=1', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('ideavault_token') || '') } }).then(function (r) { return r.json(); }),
    ])
      .then(function (all) {
        var user = all[0];
        if (user.error) throw new Error(user.error);
        
        var stats = all[1] && !all[1].error ? all[1] : {};
        var weekly = all[2] && !all[2].error ? all[2] : {};
        var ideas = all[3];
        if (ideas && ideas.error) {
          console.warn('[IdeaVault] Ideas API returned error:', ideas.error);
          ideas = [];
        } else if (!Array.isArray(ideas)) {
          ideas = [];
        }

        state.user = user;
        state.stats = stats;
        state.weekly = weekly;
        state.ideas = ideas;

        // --- AUTO-RUN REAL AI FOR PENDING IDEAS ---
        var pendingAiIdeas = ideas.filter(function (i) {
          return i.status === 'Published' && (!i.aiAnalysis || typeof i.aiAnalysis.innovationScore !== 'number');
        });

        if (pendingAiIdeas.length > 0) {
          var tok = localStorage.getItem('ideavault_token') || '';
          var toastEl = document.getElementById('iv-toast');
          if (window.__ivToast) window.__ivToast('Running real AI analysis on ' + pendingAiIdeas.length + ' ideas...');
          
          Promise.all(pendingAiIdeas.map(function(idea) {
            return fetch(API + '/ai/analysis', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
              body: JSON.stringify({ ideaId: String(idea._id) }),
            });
          }))
          .then(function() {
            if (window.__ivToast) window.__ivToast('Real AI analysis complete! Refreshing dashboard...');
            setTimeout(function() { window.location.reload(); }, 1500);
          })
          .catch(function(e) {
            console.error('Auto AI run failed', e);
          });
        }
        // ------------------------------------------


        var greet = document.querySelector('[data-top-greet]');
        if (greet) greet.textContent = '👋 ' + (user.name || 'Founder');

        var dur = 900;
        countUp(document.querySelector('[data-count="ideas"]'), stats.totalIdeas || 0, dur);
        countUp(document.querySelector('[data-count="pub"]'), stats.publishedCount || 0, dur);
        countUp(document.querySelector('[data-count="draft"]'), stats.draftCount || 0, dur);

        document.querySelector('[data-metric-likes]').textContent = String(stats.totalLikes || 0);
        document.querySelector('[data-metric-comments]').textContent = String(stats.totalComments || 0);
        document.querySelector('[data-metric-views]').textContent = String(stats.totalViews || 0);
        document.querySelector('[data-chip-conv]').textContent = (stats.conversionRate || 0) + '%';
        document.querySelector('[data-chip-eng]').textContent = (stats.engagementRate || 0) + '%';

        var minePub = ideas.filter(function (i) {
          return String(i.userId) === String(userId) && i.status === 'Published';
        });
        var h = healthFromIdeas(minePub, stats);
        document.querySelector('[data-health-num]').textContent = String(h.score);
        document.querySelector('[data-health-label]').textContent = h.label;
        setRing(h.score);
        renderFactors(h);

        var statsText =
          'Health score ' +
          h.score +
          '/100. Label: ' +
          h.label +
          '. Innovation avg ' +
          h.invAvg.toFixed(1) +
          '/10. VC fit avg ' +
          Math.round(h.vcAvg) +
          '/100. Profile engagement rate ' +
          (stats.engagementRate || 0) +
          '%. Published ideas ' +
          (stats.publishedCount || 0) +
          '.';
        var statsPayload = {
          score: h.score,
          label: h.label,
          invAvg: h.invAvg,
          vcAvg: h.vcAvg,
          eng: stats.engagementRate || 0,
          pubCount: stats.publishedCount || 0,
          invHasAi: h.invHasAi,
        };

        fetch(API + '/ai/dashboard-health', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ statsText: statsText, stats: statsPayload }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (d) {
            var el = document.querySelector('[data-health-ai-text]');
            if (!el) return;
            if (d.error && d.fromCache) {
              el.innerHTML = '<span style="color:var(--warning)"><i class="fa-solid fa-triangle-exclamation"></i> Live AI narrative is temporarily unavailable.</span> ' + 
                             'Showing cached insights based on your real engagement and local ML. We are automatically retrying with fallback providers...';
              return;
            }
            if (d.explanation) {
              var t = String(d.explanation);
              t = t.replace(/\s*\(AI unavailable:[^)]*\)\s*/gi, ' ');
              t = t.replace(/\[GoogleGenerativeAI Error\][^\n]*/gi, '');
              t = t.replace(/Gemini error after trying models[^\n]*/gi, '');
              el.textContent = t.replace(/\s{2,}/g, ' ').trim();
            }
          })
          .catch(function () {
            var el = document.querySelector('[data-health-ai-text]');
            if (el) {
              el.innerHTML = '<span style="color:var(--danger)"><i class="fa-solid fa-circle-exclamation"></i> AI service unreachable.</span> ' + 
                             'Your scores above still reflect real engagement and local ML. Please check your connection or try again later.';
            }
          });

        var ctx = document.getElementById('chart-weekly');
        if (ctx && window.Chart) {
          if (window.__ivWeeklyChart) {
            try {
              window.__ivWeeklyChart.destroy();
            } catch (e) {
              /* noop */
            }
          }
          window.__ivWeeklyChart = new Chart(ctx.getContext('2d'), {
            type: 'line',
            data: {
              labels: weekly.labels || [],
              datasets: [
                {
                  label: 'Daily Views (Reach)',
                  data: weekly.counts || [],
                  borderColor: '#6366f1',
                  backgroundColor: 'rgba(99,102,241,0.12)',
                  fill: true,
                  tension: 0.35,
                  pointBackgroundColor: '#6366f1',
                  pointRadius: 4,
                  pointHoverRadius: 6
                },
              ],
            },
            options: {
              responsive: true,
              plugins: { 
                legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } },
                tooltip: {
                  callbacks: {
                    label: function(context) { return ' ' + context.parsed.y + ' views'; }
                  }
                }
              },
              scales: {
                x: {
                  title: { display: true, text: 'Date (Last 7 Days)', color: '#94a3b8', font: { size: 10, weight: '700' } },
                  ticks: { color: '#94a3b8', font: { size: 10 } },
                  grid: { display: false }
                },
                y: { 
                  beginAtZero: true, 
                  title: { display: true, text: 'Views Count', color: '#94a3b8', font: { size: 10, weight: '700' } },
                  grid: { color: 'rgba(148,163,184,0.1)' },
                  ticks: { color: '#94a3b8', font: { size: 10 } },
                }
              }
            },
          });
        }
        document.querySelector('[data-weekly-insight]').textContent = trendInsight(weekly.counts || []);

        var trendingRoot = document.querySelector('[data-trending]');
        var publishedAll = ideas.filter(function (i) {
          return i.status === 'Published';
        });
        trendingRoot.innerHTML = publishedAll
          .slice(0, 9)
          .map(function (idea) {
            var isOwn = String(idea.userId) === String(userId);
            return IdeaVaultCard.render(idea, { isOwner: isOwn });
          })
          .join('');
        wireIdeaGrid(trendingRoot);

        var best = null;
        var bestScore = -1;
        publishedAll.forEach(function (i) {
          var sc = spotlightScore(i);
          if (sc > bestScore) {
            bestScore = sc;
            best = i;
          }
        });
        var spot = document.querySelector('[data-spotlight]');
        var wrap = document.querySelector('[data-spotlight-wrap]');
        if (best) {
          wrap.hidden = false;
          var m = best.mlPack || {};
          var a = best.aiAnalysis || {};
          var feas = a.feasibilityScore != null ? a.feasibilityScore : m.feasibilityHeuristic;
          var sent = a.sentimentLabel || m.sentimentLabel || 'Neutral';
          var trend = a.marketTrend || m.marketTrend || 'Stable';
          var bestImg = best.image && String(best.image).indexOf('data:') === 0
            ? '<img src="' + escapeHtml(best.image) + '" style="width:140px;height:140px;object-fit:cover;border-radius:18px;box-shadow:0 12px 32px rgba(0,0,0,0.25)" alt="">'
            : '<div style="width:140px;height:140px;border-radius:18px;background:linear-gradient(135deg,var(--accent),var(--accent-blue));display:flex;align-items:center;justify-content:center;color:#fff;font-size:2.5rem"><i class="fa-solid fa-crown"></i></div>';

          spot.innerHTML =
            '<div style="display:flex;gap:32px;align-items:start">' +
              bestImg +
              '<div style="flex:1">' +
                '<div class="dash-spot-meta">' +
                  '<span class="iv-badge iv-badge-success">Feasibility ' + (feas || '—') + '/10</span>' +
                  '<span class="iv-badge iv-badge-accent">Sentiment ' + sent + '</span>' +
                  '<span class="iv-badge iv-badge-warn">' + trend + '</span>' +
                '</div>' +
                '<h3 class="dash-spot-title" style="margin:8px 0 12px;font-size:1.5rem">' + escapeHtml(best.title) + '</h3>' +
                '<p class="dash-spot-excerpt" style="margin-bottom:16px;color:var(--muted);line-height:1.6">' + escapeHtml(best.aiSummary || m.localStrategicSummary || best.summary || '') + '</p>' +
                '<div class="dash-spot-stats" style="display:flex;gap:20px;font-size:0.85rem;color:var(--muted);margin-bottom:20px">' +
                  '<span><i class="fa-solid fa-eye"></i> ' + (best.views || 0) + ' views</span>' +
                  '<span><i class="fa-solid fa-heart" style="color:#ef4444"></i> ' + (best.likes ? best.likes.length : 0) + '</span>' +
                  '<span><i class="fa-solid fa-comment" style="color:var(--accent)"></i> ' + (best.comments ? best.comments.length : 0) + '</span>' +
                  '<span><i class="fa-solid fa-bolt" style="color:#f59e0b"></i> ' + (m.hotRankScore || 0) + ' (7d)</span>' +
                  '<span style="color:var(--accent);font-weight:700">Depth ' + (m.contentDepth || 0) + '%</span>' +
                '</div>' +
                '<div class="dash-spot-vc-box" style="background:rgba(99,102,241,0.08);padding:12px;border-radius:12px;margin-bottom:16px;font-size:0.85rem;border-left:4px solid var(--accent)" data-spot-vc>Predicting VC signals...</div>' +
                '<div class="dash-spot-actions" style="display:flex;gap:12px;flex-wrap:wrap">' +
                  '<button type="button" class="iv-btn iv-btn-primary iv-btn-sm" data-read-spot="' + escapeHtml(String(best._id)) + '">View Details</button>' +
                  '<button type="button" class="iv-btn iv-btn-secondary iv-btn-sm" id="btn-spot-contact" data-spot-contact-id="' +
                  escapeHtml(String(best._id)) +
                  '"><i class="fa-solid fa-address-card"></i> Contact creator</button>' +
                  '<button type="button" class="iv-btn iv-btn-secondary iv-btn-sm" onclick="checkAuthenticity(\'' + escapeHtml(String(best._id)) + '\')"><i class="fa-solid fa-shield-halved"></i> Check Authenticity</button>' +
                '</div>' +
              '</div>' +
            '</div>';
          
          // Mark spotlight with idea ID so live socket updates can target it
          spot.setAttribute('data-spotlight-idea-id', String(best._id));
          spot.querySelector('[data-read-spot]').onclick = function() { openIdeaPopup(String(best._id)); };

          var sc = spot.querySelector('#btn-spot-contact');
          if (sc && window.IdeaVaultContact) {
            sc.onclick = function () {
              IdeaVaultContact.openFromIdea(best);
            };
          }

          fetch(API + '/ai/vc-match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ideaId: String(best._id) }),
          })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              var el = spot.querySelector('[data-spot-vc]');
              if (!el) return;
              var msg = '';
              if (d.matches && d.matches.length) {
                var t = d.matches[0];
                var nm = t.investor && t.investor.name ? t.investor.name : 'Investor';
                msg = 'VC Signal: ' + nm + ' ~' + Math.round(t.score || 0) + '% fit.';
              } else {
                msg = 'VC Signal: Assessing rule-based matching...';
              }
              el.textContent = msg;
              return fetch(API + '/vc/idea-signals/' + encodeURIComponent(String(best._id)));
            })
            .then(function (r2) { return r2 ? r2.json() : null; })
            .then(function (sig) {
              var el = spot.querySelector('[data-spot-vc]');
              if (!el || !sig || sig.error || sig.activeInterests == null) return;
              var extra = ' Live VC pipeline: ' + sig.activeInterests + ' active · ₹' + (sig.committedInr || sig.committedUsd * 83 || 0).toLocaleString() + ' committed.';
              el.textContent = el.textContent + ' · ' + extra;
            })
            .catch(function () {});
        }

        var pubVentureRoot = document.querySelector('[data-published-ventures]');
        if (pubVentureRoot) {
          if (!minePub.length) {
            pubVentureRoot.innerHTML = '<p style="color:var(--muted)">No published ventures yet.</p>';
          } else {
            pubVentureRoot.innerHTML = minePub
              .map(function (idea) {
                return IdeaVaultCard.render(idea, { isOwner: true });
              })
              .join('');
            wireIdeaGrid(pubVentureRoot);
          }
        }

        var drafts = ideas.filter(function (i) {
          return String(i.userId) === String(userId) && i.status === 'Draft';
        });
        var droot = document.querySelector('[data-drafts]');
        if (!drafts.length) {
          droot.innerHTML = '<p style="color:var(--muted)">No drafts — start something new. <a href="/create-idea.html" class="iv-btn iv-btn-primary iv-btn-sm" style="margin-left:12px">+ New Idea</a></p>';
        } else {
          droot.innerHTML = drafts
            .map(function (d) {
              var filled = [d.title, d.problem, d.solution, d.category].filter(Boolean).length;
              var pct = Math.round((filled / 4) * 100);
              var updatedStr = d.updatedAt ? new Date(d.updatedAt).toLocaleDateString() : (d.createdAt ? new Date(d.createdAt).toLocaleDateString() : 'Recently');
              // Render full IdeaVaultCard for drafts so AI analysis strips show
              var cardHtml = IdeaVaultCard.render(d, { isOwner: true });
              return (
                '<div class="dash-draft-card-wrap" style="position:relative">' +
                '<div class="iv-draft-badge" style="position:absolute;top:14px;right:14px;z-index:10;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;font-size:0.7rem;font-weight:700;letter-spacing:0.08em;padding:3px 10px;border-radius:20px;text-transform:uppercase">Draft</div>' +
                cardHtml +
                '<div class="dash-draft-footer" style="padding:12px 18px;background:rgba(245,158,11,0.06);border-top:1px solid rgba(245,158,11,0.18);border-radius:0 0 16px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px">' +
                '<div style="display:flex;align-items:center;gap:10px">' +
                '<div class="dash-progress" style="width:100px"><span style="width:' + pct + '%"></span></div>' +
                '<span style="font-size:0.78rem;color:var(--muted)">' + pct + '% complete</span>' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:8px">' +
                '<span style="font-size:0.75rem;color:var(--muted)">Updated ' + escapeHtml(updatedStr) + '</span>' +
                '<a class="iv-btn iv-btn-primary iv-btn-sm" href="/create-idea.html?id=' + encodeURIComponent(String(d._id)) + '"><i class="fa-solid fa-pen"></i> Edit Draft</a>' +
                '</div>' +
                '</div>' +
                '</div>'
              );
            })
            .join('');
          wireIdeaGrid(droot);
        }
      })
      .catch(function (e) {
        console.error('[IdeaVault Dashboard Error]', e);
        // Removed annoying alert box
      });
  }
  loadAll();
  document.addEventListener('ideavault:refresh', function () {
    loadAll();
  });
  document.addEventListener('ideavault:notify', function (ev) {
    var t = ev && ev.detail && ev.detail.text;
    if (t && typeof t === 'string') {
      try {
        if (typeof window !== 'undefined' && window.__ivToast) window.__ivToast(t);
        else console.info('[IdeaVault]', t);
      } catch (e) {
        /* noop */
      }
    }
  });
  window.checkAuthenticity = function(id) {
    var idea = state.ideas.find(i => String(i._id) === String(id));
    if (!idea || !idea.mlPack || !idea.mlPack.authenticity) {
      alert("Authenticity data pending analysis.");
      return;
    }
    var auth = idea.mlPack.authenticity;
    var msg = "Authenticity Check (Jaccard Similarity)\n\n";
    if (auth.similarity > 15) {
      msg += "⚠️ Overlap detected\n";
      msg += "Uniqueness: " + (100 - auth.similarity) + "% · Similarity: " + auth.similarity + "%\n\n";
      if (auth.closestMatch) {
        msg += "Closest match:\n" + auth.closestMatch.title + "\nCategory: " + auth.closestMatch.category + "\n\n";
        msg += "AI verdict: This idea shows high conceptual overlap with existing entries (" + auth.similarity + "% similarity). Consider refining the unique value proposition to differentiate further.";
      }
    } else {
      msg += "✅ High Uniqueness\n";
      msg += "Similarity Score: " + auth.similarity + "%\n\n";
      msg += "AI verdict: This idea appears highly unique within the IdeaVault network. Great work on innovation!";
    }
    alert(msg);
  };

  window.matchInvestors = async function(id) {
    try {
      window.__ivToast("Searching for top VC matches...");
      const res = await fetch(API + '/investors/match/' + id);
      const matches = await res.json();
      if (!matches || !matches.length) {
        alert("No suitable VCs found for this sector yet.");
        return;
      }
      const top = matches[0];
      const idea = state.ideas.find(i => String(i._id) === String(id));
      if (idea) {
        idea.dynamicMatchName = top.investor.name;
        idea.dynamicMatchScore = top.matchScore;
        // Refresh UI
        loadAll();
      }
      alert("Top Match Found: " + top.investor.name + " (" + top.matchScore + "% fit)\n\n" + top.investor.description);
    } catch (e) { console.error(e); }
  };

  window.buildSimilarStartup = function (ideaJson) {
    try {
      if (ideaJson && String(ideaJson).length === 24 && /^[a-f0-9]+$/i.test(String(ideaJson))) {
        if (window.IdeaVaultContact && IdeaVaultContact.runBuildSimilarById) {
          IdeaVaultContact.runBuildSimilarById(ideaJson);
        }
        return;
      }
      const idea = JSON.parse(ideaJson);
      localStorage.setItem(
        'iv_draft_copy',
        JSON.stringify({
          title: 'Inspired by ' + idea.title,
          category: idea.category,
          problem: idea.problem,
          solution: 'A new take on ' + idea.solution,
          tags: idea.tags,
          idealCustomer: idea.idealCustomer,
        }),
      );
      window.location.href = '/create-idea.html?fromInspired=1';
    } catch (e) {
      console.error(e);
    }
  };
})();
