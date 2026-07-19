/* ====================================================================
   AI Generator — IdeaVault (Real AI via Claude API)
   All idea generation is done through the backend /api/ai/generator
   route which calls Anthropic Claude for real-time AI analysis.
   ==================================================================== */

const API = window.location.origin + '/api';

/* ── Helpers ── */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem('iv_gen_history') || '[]');
  } catch { return []; }
}

function saveHistory(list) {
  try {
    // Keep last 12 entries
    localStorage.setItem('iv_gen_history', JSON.stringify(list.slice(0, 12)));
  } catch {}
}

/* ── Loading status messages (rotate while AI is processing) ── */
const LOADING_MSGS = [
  'Analyzing market landscape and innovation opportunities…',
  'Scanning competitive dynamics in this sector…',
  'Identifying unmet customer needs and pain points…',
  'Evaluating technology feasibility and innovation vectors…',
  'Synthesizing market gap analysis and unique positioning…',
  'Crafting your personalized startup concept…',
  'Running differentiation and viability assessment…',
  'Finalizing problem-solution fit and value proposition…',
];

let loadingInterval = null;
let currentResult = null;

/* ── Render History ── */
function renderHistory() {
  const container = document.getElementById('history-grid');
  const history = getHistory();
  if (!history.length) {
    container.innerHTML = '<div class="history-empty"><i class="fa-solid fa-wand-magic-sparkles" style="font-size:1.5rem;margin-bottom:8px;display:block;color:var(--accent)"></i>Your generated ideas will appear here after you create them.</div>';
    return;
  }
  container.className = 'history-grid';
  container.innerHTML = history.map(function(item, idx) {
    const date = item.generatedAt
      ? new Date(item.generatedAt).toLocaleDateString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    return '<div class="card history-card" data-hist-idx="' + idx + '">'
      + '<span class="history-cat">' + esc(item.category || '') + '</span>'
      + '<h4 class="history-title">' + esc(item.title || 'Untitled') + '</h4>'
      + '<p class="history-preview">' + esc(item.problem || '') + '</p>'
      + '<div class="history-time"><i class="fa-regular fa-clock"></i> ' + esc(date) + '</div>'
      + '</div>';
  }).join('');

  container.querySelectorAll('[data-hist-idx]').forEach(function(el) {
    el.addEventListener('click', function() {
      const idx = Number(el.getAttribute('data-hist-idx'));
      const item = getHistory()[idx];
      if (item) showResult(item);
    });
  });
}

/* ── Show Result ── */
function showResult(idea) {
  currentResult = idea;

  document.getElementById('gen-loading').classList.remove('active');
  document.getElementById('gen-result').classList.add('active');

  // Scroll to result
  document.getElementById('gen-result').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Populate result card
  document.getElementById('res-title').textContent = idea.title || 'Generated Startup Idea';
  document.getElementById('res-category').textContent = idea.category || '';
  document.getElementById('res-meta').textContent = idea.generatedAt
    ? 'Generated ' + new Date(idea.generatedAt).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';
  document.getElementById('res-problem').textContent = idea.problem || '';
  document.getElementById('res-solution').textContent = idea.solution || '';
  document.getElementById('res-customer').textContent = idea.idealCustomer || '';
  document.getElementById('res-unique').textContent = idea.uniqueValue || '';
  document.getElementById('res-innovation').textContent = idea.innovationAngle || '';
  document.getElementById('res-gap').textContent = idea.marketGap || '';

  // Tags
  const tagsEl = document.getElementById('res-tags');
  const tags = idea.tags || [];
  tagsEl.innerHTML = tags.map(function(t) {
    return '<span class="result-tag">' + esc(t) + '</span>';
  }).join('');
  if (!tags.length) tagsEl.innerHTML = '<span style="color:var(--muted);font-size:.85rem">No tags generated</span>';
}

/* ── Generate Idea (Real AI Call) ── */
async function generateIdea(category, description) {
  const loadingEl = document.getElementById('gen-loading');
  const resultEl = document.getElementById('gen-result');
  const errorEl = document.getElementById('gen-error');
  const btn = document.getElementById('gen-btn');

  // Reset UI
  errorEl.textContent = '';
  resultEl.classList.remove('active');
  loadingEl.classList.add('active');
  btn.classList.add('loading');
  btn.disabled = true;

  // Rotate loading messages
  let msgIdx = 0;
  const statusEl = document.getElementById('loading-status');
  loadingInterval = setInterval(function() {
    msgIdx = (msgIdx + 1) % LOADING_MSGS.length;
    statusEl.textContent = LOADING_MSGS[msgIdx];
  }, 2200);

  try {
    const res = await fetch(API + '/ai/generator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: category, description: description }),
    });

    const data = await res.json();

    if (data.error) {
      throw new Error(data.error);
    }

    const idea = data.idea || data;
    idea.generatedAt = new Date().toISOString();
    idea.inputCategory = category;
    idea.inputDescription = description;

    // Show the result
    showResult(idea);

    // Auto-save to history
    const history = getHistory();
    history.unshift(idea);
    saveHistory(history);
    renderHistory();

  } catch (err) {
    loadingEl.classList.remove('active');
    var msg = err && err.message ? String(err.message) : 'AI generation failed.';
    var low = msg.toLowerCase();
    if (msg.indexOf('404') !== -1 || low.indexOf('not found') !== -1) {
      msg = 'AI Model unavailable. Check GEMINI_MODEL or fallback providers in .env.';
    } else if (low.indexOf('fetch failed') !== -1) {
      msg = 'Could not reach AI providers. Check internet connection and API keys in .env.';
    } else if (low.indexOf('429') !== -1 || low.indexOf('quota') !== -1 || low.indexOf('too many requests') !== -1) {
      msg = 'AI providers are currently exhausted due to high traffic or quota limits. Please wait and try again later.';
    } else if (low.indexOf('all configured ai providers failed') !== -1) {
      msg = 'All AI providers in the fallback chain (Gemini, Groq, OpenRouter) failed. Please check API quotas.';
    }
    errorEl.textContent = msg;
  } finally {
    clearInterval(loadingInterval);
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

/* ── Use This Idea → Pre-fill create-idea form ── */
function useThisIdea() {
  if (!currentResult) return;
  // Store in localStorage for create-idea.html to pick up
  localStorage.setItem('iv_prefill_idea', JSON.stringify({
    title: currentResult.title || '',
    category: currentResult.category || '',
    tags: (currentResult.tags || []).join(', '),
    idealCustomer: currentResult.idealCustomer || '',
    problem: currentResult.problem || '',
    solution: currentResult.solution || '',
    summary: (currentResult.uniqueValue || '') + ' ' + (currentResult.innovationAngle || ''),
  }));
  window.location.href = '/create-idea.html';
}

/* ── Event Listeners ── */
document.addEventListener('DOMContentLoaded', function() {
  if (window.ivFetchMoneyConfig) {
    window.ivFetchMoneyConfig(API);
  }
  if (window.IV_CATEGORIES && document.getElementById('gen-category')) {
    var sel = document.getElementById('gen-category');
    sel.innerHTML = '<option value="">— select a category —</option>';
    window.IV_CATEGORIES.forEach(function (c) {
      var o = document.createElement('option');
      o.textContent = c;
      sel.appendChild(o);
    });
  }

  // Render past history
  renderHistory();

  // Form submission
  document.getElementById('gen-form').addEventListener('submit', function(e) {
    e.preventDefault();
    const category = document.getElementById('gen-category').value;
    const desc = document.getElementById('gen-desc').value.trim();
    const target = document.getElementById('gen-target').value.trim();

    if (!category) {
      document.getElementById('gen-error').textContent = 'Please select a category.';
      return;
    }
    if (!desc) {
      document.getElementById('gen-error').textContent = 'Please describe your idea concept.';
      return;
    }

    // Combine description with target audience if provided
    const fullDesc = target
      ? desc + '\nTarget audience: ' + target
      : desc;

    generateIdea(category, fullDesc);
  });

  // Use This Idea
  document.getElementById('btn-use-idea').addEventListener('click', useThisIdea);

  // Generate Another
  document.getElementById('btn-regenerate').addEventListener('click', function() {
    document.getElementById('gen-result').classList.remove('active');
    document.getElementById('gen-desc').focus();
    // Re-submit with same values but force fresh generation
    const category = document.getElementById('gen-category').value;
    const desc = document.getElementById('gen-desc').value.trim();
    const target = document.getElementById('gen-target').value.trim();
    if (category && desc) {
      const fullDesc = target ? desc + '\nTarget audience: ' + target : desc;
      // Add timestamp to make it unique (bypasses cache)
      generateIdea(category, fullDesc + '\n[Variation seed: ' + Date.now() + ']');
    }
  });

  // Save to History (manual)
  document.getElementById('btn-save-history').addEventListener('click', function() {
    if (!currentResult) return;
    const history = getHistory();
    // Check if already saved
    const exists = history.some(function(h) { return h.title === currentResult.title; });
    if (exists) {
      this.innerHTML = '<i class="fa-solid fa-check"></i> Already Saved';
      return;
    }
    history.unshift(currentResult);
    saveHistory(history);
    renderHistory();
    this.innerHTML = '<i class="fa-solid fa-check"></i> Saved!';
    setTimeout(function() {
      document.getElementById('btn-save-history').innerHTML = '<i class="fa-solid fa-bookmark"></i> Save to History';
    }, 2000);
  });
});
