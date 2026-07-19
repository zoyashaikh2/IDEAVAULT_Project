const API = window.location.origin + '/api';

(function () {
  var userId = localStorage.getItem('ideavault_userId');
  if (!userId) {
    window.location.href = '/login.html';
    return;
  }

  var toggles = { summary: false, analysis: false, roadmap: false };

  if (window.ivFetchMoneyConfig) {
    window.ivFetchMoneyConfig(API);
  }

  function qs(sel) {
    return document.querySelector(sel);
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function ivHumanizeAiError(msg) {
    var s = String(msg || '');
    var low = s.toLowerCase();
    if (s.indexOf('404') !== -1 || low.indexOf('not found') !== -1) {
      return 'AI Model unavailable. Check GEMINI_MODEL or fallback providers in .env.';
    }
    if (low.indexOf('fetch failed') !== -1) {
      return 'Could not reach AI providers. Check internet connection and API keys in .env.';
    }
    if (low.indexOf('429') !== -1 || low.indexOf('quota') !== -1 || low.indexOf('too many requests') !== -1) {
      return 'AI providers are currently exhausted due to high traffic or quota limits. Trying local ML fallback where possible, please try again later.';
    }
    if (low.indexOf('all configured ai providers failed') !== -1) {
      return 'All AI providers in the fallback chain (Gemini, Groq, OpenRouter) failed. Using local ML fallbacks for now. Please check API quotas.';
    }
    if (s.length > 240) return s.slice(0, 240) + '…';
    return s;
  }

  function fillCategorySelects() {
    var cats = (window.IV_CATEGORIES || []).slice();
    ['#category', '#gen-category'].forEach(function (sel) {
      var el = qs(sel);
      if (!el) return;
      var cur = el.value;
      var prefix = sel === '#gen-category' ? '<option value="">— Select category —</option>' : '';
      el.innerHTML =
        prefix +
        cats
          .map(function (c) {
            return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
          })
          .join('');
      if (cur && cats.indexOf(cur) >= 0) el.value = cur;
    });
  }
  fillCategorySelects();

  function formatAnalysisHtml(a) {
    if (!a || typeof a !== 'object') return '<p style="color:var(--muted)">No analysis data.</p>';
    var sw = a.swot || {};
    function ul(key) {
      var xs = sw[key] || [];
      if (!xs.length) return '<li>—</li>';
      return xs
        .map(function (x) {
          return '<li>' + escapeHtml(x) + '</li>';
        })
        .join('');
    }
    var scores =
      'Innovation ' +
      (a.innovationScore != null ? escapeHtml(String(a.innovationScore)) : '—') +
      '/10 · Feasibility ' +
      (a.feasibilityScore != null ? escapeHtml(String(a.feasibilityScore)) : '—') +
      '/10 · Risk ' +
      (a.riskScore != null ? escapeHtml(String(a.riskScore)) : '—') +
      '/10 · VC fit ' +
      (a.vcFitScore != null ? escapeHtml(String(a.vcFitScore)) : '—') +
      '/100';
    return (
      '<div class="ai-prose">' +
      '<p><strong>Market snapshot</strong><br />' +
      escapeHtml(a.marketSummary || '—') +
      '</p>' +
      '<p><strong>Scores</strong><br />' +
      scores +
      '</p>' +
      '<p><strong>Why this score</strong><br />' +
      escapeHtml(a.explanation || '—') +
      '</p>' +
      '<p><strong>Revenue outlook</strong> Y1: ' +
      escapeHtml(String(a.revenueY1 || '—')) +
      ' · Y3: ' +
      escapeHtml(String(a.revenueY3 || '—')) +
      ' · YoY: ' +
      escapeHtml(String(a.yoyGrowth || '—')) +
      '</p>' +
      '<h4>SWOT (AI)</h4><div class="swot-mini"><div><b>S</b><ul>' +
      ul('strengths') +
      '</ul></div><div><b>W</b><ul>' +
      ul('weaknesses') +
      '</ul></div><div><b>O</b><ul>' +
      ul('opportunities') +
      '</ul></div><div><b>T</b><ul>' +
      ul('threats') +
      '</ul></div></div></div>'
    );
  }

  function formatRoadmapHtml(rm) {
    if (!rm || typeof rm !== 'object') return '<p style="color:var(--muted)">No roadmap.</p>';
    var phases = rm.phases || [];
    return (
      '<p><strong>Total budget (model)</strong> ' +
      escapeHtml(String(rm.totalBudget || '—')) +
      '</p><p><strong>Timeline</strong> ' +
      escapeHtml(String(rm.totalTimeline || '—')) +
      '</p>' +
      phases
        .map(function (p, idx) {
          return (
            '<div class="roadmap-phase"><h4>Phase ' +
            (idx + 1) +
            ': ' +
            escapeHtml(p.name || '') +
            '</h4><p><em>' +
            escapeHtml(p.duration || '') +
            '</em><br /><strong>Budget:</strong> ' +
            escapeHtml(p.budget || '—') +
            '</p><ul>' +
            (p.tasks || [])
              .map(function (t) {
                return '<li>' + escapeHtml(t) + '</li>';
              })
              .join('') +
            '</ul></div>'
          );
        })
        .join('')
    );
  }

  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.style.color =
      kind === 'error' ? '#dc2626' : kind === 'success' ? '#059669' : 'var(--muted)';
  }

  function getQuery(name) {
    var u = new URL(window.location.href);
    return u.searchParams.get(name);
  }

  function parseTags(s) {
    if (!s) return [];
    return String(s)
      .split(',')
      .map(function (t) {
        return t.trim();
      })
      .filter(Boolean);
  }

  function fillForm(idea) {
    qs('#idea-id').value = idea._id || '';
    qs('#title').value = idea.title || '';
    qs('#tags').value = (idea.tags && idea.tags.join(', ')) || '';
    qs('#idealCustomer').value = idea.idealCustomer || '';
    // Support legacy field names (problemStatement → problem, proposedSolution → solution)
    qs('#problem').value = idea.problem || idea.problemStatement || '';
    qs('#solution').value = idea.solution || idea.proposedSolution || '';
    qs('#summary').value = idea.summary || '';
    // Support legacy referenceLink field
    qs('#link').value = idea.link || idea.referenceLink || '';
    qs('#status').value = idea.status || 'Draft';

    // Set category – must wait for IV_CATEGORIES options to be populated
    function applyCategory() {
      var cat = idea.category || '';
      if (!cat) return;
      var sel = qs('#category');
      if (!sel) return;
      // Check if option exists safely (avoiding querySelector syntax errors with slashes)
      var options = Array.prototype.slice.call(sel.options);
      var exists = false;
      for (var i = 0; i < options.length; i++) {
        if (options[i].value === cat) {
          exists = true;
          break;
        }
      }
      if (exists) {
        sel.value = cat;
      } else {
        setTimeout(function () {
          fillCategorySelects();
          sel.value = cat;
        }, 300);
      }
    }
    applyCategory();

    if (idea.image && String(idea.image).indexOf('data:') === 0) {
      var img = qs('#img-preview');
      img.src = idea.image;
      img.hidden = false;
      qs('#btn-clear-img').hidden = false;
    }

    // Display existing AI Data from MongoDB
    if (idea.aiSummary) {
      showBox('box-summary', true);
      qs('#out-summary').textContent = idea.aiSummary;
    }
    if (idea.aiAnalysis && typeof idea.aiAnalysis === 'object' && Object.keys(idea.aiAnalysis).length > 0) {
      showBox('box-analysis', true);
      qs('#out-analysis').innerHTML = formatAnalysisHtml(idea.aiAnalysis);
    }
    if (idea.aiRoadmap && typeof idea.aiRoadmap === 'object' && Object.keys(idea.aiRoadmap).length > 0) {
      showBox('box-roadmap', true);
      qs('#out-roadmap').innerHTML = formatRoadmapHtml(idea.aiRoadmap);
    }

    // Show editing banner
    var h1 = document.querySelector('.create-title');
    if (h1) h1.textContent = 'Edit your idea';
    var sub = document.querySelector('.create-sub');
    if (sub) sub.textContent = 'Update your details below and save to re-run AI analysis.';
  }

  function serializeForm() {
    return {
      userId: userId,
      title: qs('#title').value.trim(),
      category: qs('#category').value.trim(),
      tags: parseTags(qs('#tags').value),
      idealCustomer: qs('#idealCustomer').value.trim(),
      problem: qs('#problem').value.trim(),
      solution: qs('#solution').value.trim(),
      summary: qs('#summary').value.trim(),
      link: qs('#link').value.trim(),
      status: qs('#status').value,
      image: (qs('#img-preview').hidden ? '' : qs('#img-preview').src) || '',
    };
  }

  // Top nav wiring
  var prof = document.querySelector('[data-top-profile]');
  if (prof) prof.setAttribute('href', '/profile.html?userId=' + encodeURIComponent(userId));
  var logout = document.querySelector('[data-top-logout]');
  if (logout) {
    logout.addEventListener('click', function () {
      localStorage.removeItem('ideavault_userId');
      localStorage.removeItem('ideavault_token');
      window.location.href = '/login.html';
    });
  }

  // Toggle cards
  document.querySelectorAll('.create-toggle[data-toggle]').forEach(function (el) {
    el.addEventListener('click', function () {
      var key = el.getAttribute('data-toggle');
      toggles[key] = !toggles[key];
      el.classList.toggle('is-on', toggles[key]);
    });
  });

  // Image upload → base64
  var fileInput = qs('#image');
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = qs('#img-preview');
      img.src = String(e.target.result || '');
      img.hidden = false;
      qs('#btn-clear-img').hidden = false;
    };
    reader.readAsDataURL(f);
  });

  qs('#btn-clear-img').addEventListener('click', function () {
    qs('#img-preview').src = '';
    qs('#img-preview').hidden = true;
    qs('#btn-clear-img').hidden = true;
    qs('#image').value = '';
  });

  // Load existing idea for edit (drafts)
  var editId = getQuery('id');
  if (editId) {
    var editHeaders = {};
    var editTok = localStorage.getItem('ideavault_token');
    if (editTok) editHeaders['Authorization'] = 'Bearer ' + editTok;
    fetch(API + '/ideas/' + encodeURIComponent(editId) + '?noView=1', {
      headers: editHeaders
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (idea) {
        if (idea && !idea.error) fillForm(idea);
      })
      .catch(function () {});
  }

  // Handle authenticity check from dashboard spotlight
  var checkId = getQuery('check');
  if (checkId) {
    fetch(API + '/ideas/' + encodeURIComponent(checkId) + '?noView=1')
      .then(function (r) {
        return r.json();
      })
      .then(function (idea) {
        if (idea && !idea.error) {
          fillForm(idea);
          // Auto-trigger duplicate check
          setTimeout(function() { qs('#btn-duplicate').click(); }, 500);
        }
      })
      .catch(function () {});
  }

  // Pre-fill from AI Generator page (localStorage)
  try {
    var prefill = localStorage.getItem('iv_prefill_idea');
    if (prefill && !editId) {
      var pf = JSON.parse(prefill);
      if (pf.title) qs('#title').value = pf.title;
      if (pf.category) qs('#category').value = pf.category;
      if (pf.tags) qs('#tags').value = pf.tags;
      if (pf.idealCustomer) qs('#idealCustomer').value = pf.idealCustomer;
      if (pf.problem) qs('#problem').value = pf.problem;
      if (pf.solution) qs('#solution').value = pf.solution;
      if (pf.summary) qs('#summary').value = pf.summary;
      localStorage.removeItem('iv_prefill_idea');
    }
  } catch (e) {}

  // Pre-fill from "Build Similar" (inspired.html)
  try {
    var draftCopy = localStorage.getItem('iv_draft_copy');
    if (draftCopy && getQuery('fromInspired')) {
      var dc = JSON.parse(draftCopy);
      if (dc.title) qs('#title').value = dc.title;
      if (dc.category) qs('#category').value = dc.category;
      if (dc.problem) qs('#problem').value = dc.problem;
      if (dc.solution) qs('#solution').value = dc.solution;
      if (dc.tags) qs('#tags').value = Array.isArray(dc.tags) ? dc.tags.join(', ') : dc.tags;
      if (dc.idealCustomer) qs('#idealCustomer').value = dc.idealCustomer;
      localStorage.removeItem('iv_draft_copy');
      window.__ivToast && window.__ivToast("Draft pre-filled from inspired idea!");
    }
  } catch (e) {}


  // AI generator -> fill
  qs('#btn-generate').addEventListener('click', function () {
    var desc = qs('#gen-desc').value.trim();
    var cat = qs('#gen-category').value;
    var st = qs('#gen-status');
    if (!desc) return setStatus(st, 'Please describe your concept first.', 'error');
    if (!cat) return setStatus(st, 'Please select a category.', 'error');
    setStatus(st, 'Generating…', 'info');
    fetch(API + '/ai/generator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: cat, description: desc }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d.error) throw new Error(d.error);
        var idea = d.idea || {};
        qs('#title').value = idea.title || '';
        qs('#category').value = idea.category || cat || '';
        qs('#idealCustomer').value = idea.idealCustomer || '';
        qs('#problem').value = idea.problem || '';
        qs('#solution').value = idea.solution || '';
        if (Array.isArray(idea.tags)) qs('#tags').value = idea.tags.join(', ');
        setStatus(st, d.cached ? 'Generated (cached).' : 'Generated.', 'success');
      })
      .catch(function (e) {
        setStatus(st, ivHumanizeAiError(e.message), 'error');
      });
  });

  // Save (create or update)
  qs('#idea-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var saveSt = qs('#save-status');
    var payload = serializeForm();
    if (!payload.title) return setStatus(saveSt, 'Title is required.', 'error');
    if (!payload.problem) return setStatus(saveSt, 'Problem statement is required.', 'error');

    var id = qs('#idea-id').value;
    var isEdit = !!id;
    var isDraft = payload.status === 'Draft';
    setStatus(saveSt, 'Saving…', 'info');
    var tok = localStorage.getItem('ideavault_token') || '';
    var headers = { 'Content-Type': 'application/json' };
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    fetch(API + (isEdit ? '/ideas/' + encodeURIComponent(id) : '/ideas'), {
      method: isEdit ? 'PUT' : 'POST',
      headers: headers,
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (idea) {
        if (idea.error) throw new Error(idea.error);
        qs('#idea-id').value = idea._id;
        var hasToggles = toggles.summary || toggles.analysis || toggles.roadmap;
        if (hasToggles) {
          setStatus(saveSt, 'Saved! Running AI analysis…', 'success');
          runSelectedAIAndRedirect(idea._id, isDraft);
        } else {
          // No AI toggles — save and redirect to dashboard (shows drafts section for drafts)
          setStatus(saveSt, isEdit ? '✅ Updated! Redirecting to dashboard…' : (isDraft ? '✅ Draft saved! Redirecting to dashboard…' : '✅ Idea published! Redirecting to dashboard…'), 'success');
          setTimeout(function () {
            window.location.href = '/dashboard.html';
          }, 1200);
        }
      })
      .catch(function (err) {
        setStatus(saveSt, err.message || 'Save failed.', 'error');
      });
  });


  function showBox(id, visible) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = !visible;
  }

  function runSelectedAI(ideaId) {
    var queue = [];
    if (toggles.summary) queue.push('summary');
    if (toggles.analysis) queue.push('analysis');
    if (toggles.roadmap) queue.push('roadmap');
    if (!queue.length) return;

    var p = Promise.resolve();
    queue.forEach(function (kind) {
      p = p.then(function () {
        return runAI(kind, ideaId);
      });
    });
  }

  function runSelectedAIAndRedirect(ideaId, isDraft) {
    var queue = [];
    if (toggles.summary) queue.push('summary');
    if (toggles.analysis) queue.push('analysis');
    if (toggles.roadmap) queue.push('roadmap');
    if (!queue.length) {
      setTimeout(function() { window.location.href = '/dashboard.html'; }, 800);
      return;
    }

    var p = Promise.resolve();
    queue.forEach(function (kind) {
      p = p.then(function () {
        return runAI(kind, ideaId);
      });
    });
    p.then(function() {
      var saveSt = qs('#save-status');
      setStatus(saveSt, '✅ AI complete! Redirecting to dashboard…', 'success');
      setTimeout(function() { window.location.href = '/dashboard.html'; }, 1500);
    }).catch(function(e) {
      var saveSt = qs('#save-status');
      setStatus(saveSt, 'Saved (some AI tasks failed). Redirecting…', 'error');
      setTimeout(function() { window.location.href = '/dashboard.html'; }, 2000);
    });
  }

  function runAI(kind, ideaId) {
    var endpoint =
      kind === 'summary'
        ? '/ai/summary'
        : kind === 'analysis'
          ? '/ai/analysis'
          : '/ai/roadmap';
    var tok = localStorage.getItem('ideavault_token') || '';
    var headers = { 'Content-Type': 'application/json' };
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    
    return fetch(API + endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ ideaId: ideaId }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d.error) throw new Error(d.error);
        if (kind === 'summary') {
          showBox('box-summary', true);
          qs('#out-summary').textContent = d.summary || '';
        } else if (kind === 'analysis') {
          showBox('box-analysis', true);
          qs('#out-analysis').innerHTML = formatAnalysisHtml(d.analysis || {});
        } else if (kind === 'roadmap') {
          showBox('box-roadmap', true);
          qs('#out-roadmap').innerHTML = formatRoadmapHtml(d.roadmap || {});
        }
      })
      .catch(function (e) {
        var saveSt = qs('#save-status');
        setStatus(saveSt, 'Saved; ' + kind + ' not generated: ' + ivHumanizeAiError(e && e.message), 'error');
      });
  }

  qs('#btn-duplicate').addEventListener('click', function () {
    var title = qs('#title').value.trim();
    var category = qs('#category').value.trim();
    var problem = qs('#problem').value.trim();
    var solution = qs('#solution').value.trim();
    var body = qs('#dup-body');
    body.innerHTML = '<p style=\"color:var(--muted)\">Checking…</p>';
    qs('#popup-dup').classList.add('is-open');

    fetch(API + '/ideas/check-duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, category: category, problem: problem, solution: solution }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d.error) throw new Error(d.error);
        var verdict = d.isDuplicate ? 'Overlap detected' : 'Looks original';
        body.innerHTML =
          '<h3 style=\"margin:0 0 10px\">' +
          escapeHtml(verdict) +
          '</h3>' +
          '<p style=\"margin:0 0 10px;color:var(--muted)\">Uniqueness: <strong>' +
          escapeHtml(String(Math.max(0, Math.min(100, Math.round(100 - (d.similarity || 0)))))) +
          '%</strong> · Similarity: <strong>' +
          escapeHtml(String(d.similarity || 0)) +
          '%</strong></p>' +
          (d.closestMatch
            ? '<div class=\"card\" style=\"padding:14px;margin-bottom:10px\"><strong>Closest match:</strong><br/>' +
              escapeHtml(d.closestMatch.title || '') +
              '<br/><span style=\"color:var(--muted);font-size:0.9rem\">Category: ' +
              escapeHtml(d.closestMatch.category || '') +
              '</span></div>'
            : '<p style=\"color:var(--muted)\">No close matches found.</p>') +
          (d.aiVerdict
            ? '<div class=\"card\" style=\"padding:14px\"><strong>AI verdict</strong><p style=\"margin:8px 0 0;color:var(--muted);line-height:1.55\">' +
              escapeHtml(d.aiVerdict) +
              '</p></div>'
            : '');
      })
      .catch(function () {
        body.innerHTML = '<p style=\"color:var(--danger)\">Could not run check.</p>';
      });
  });

  document.querySelector('[data-close-dup]').addEventListener('click', function () {
    qs('#popup-dup').classList.remove('is-open');
  });
  qs('#popup-dup').addEventListener('click', function (e) {
    if (e.target && e.target.id === 'popup-dup') qs('#popup-dup').classList.remove('is-open');
  });
})();
