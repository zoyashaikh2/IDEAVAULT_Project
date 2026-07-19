/**
 * Unified Idea Card Component for IdeaVault
 * Handles rendering of cards across Dashboard, Get Inspired, and Create Idea preview.
 */

(function (global) {
  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function encContactPayload(idea) {
    return encodeURIComponent(
      JSON.stringify({
        email: idea.email || '',
        phone: idea.phone || '',
        creatorName: idea.name || 'Founder',
        ideaTitle: idea.title || '',
      }),
    );
  }

  function renderIdeaCard(idea, opts) {
    opts = opts || {};
    var m = idea.mlPack || {};
    var a = idea.aiAnalysis || {};

    // Use live server-computed sentiment from mlPack (Naive Bayes + engagement heuristic)
    var lCount = (idea.likes || []).length;
    var cCount = (idea.comments || []).length;
    // The backend always returns mlPack.naiveBayesSentiment — derive display label consistently
    var nb = m.naiveBayesSentiment || {};
    if (lCount === 0 && cCount === 0) {
      nb = { label: 'Negative', emoji: '📉' };
    } else if (!nb.label) {
      var sl = lCount > 2 || cCount > 1 ? 'positive' : 'neutral';
      nb = { label: sl, emoji: sl === 'positive' ? '🚀' : '😐' };
    }

    var creatorId = idea.userId ? String(idea.userId) : '';
    var creatorName = esc(idea.name || 'Founder');
    var isLiked = (idea.likes || []).some(function(id) { return String(id) === String(window._ivUserId); });


    // 1. ML Analysis Strip (Header)
    var stripHtml = '';
    if (window.IdeaVaultStrategic && IdeaVaultStrategic.analysisStripHtml) {
      stripHtml = IdeaVaultStrategic.analysisStripHtml(idea);
    }

    // 2. Image / Fallback
    var imgHtml = '';
    if (idea.image && String(idea.image).indexOf('data:') === 0) {
      imgHtml = '<img src="' + esc(idea.image) + '" class="iv-card-image" alt="Startup Image">';
    } else {
      imgHtml = '<div class="iv-card-image-fallback"><i class="fa-solid fa-rocket"></i></div>';
    }

    // 3. VC Signal Highlight
    var vcMatch = idea.dynamicMatchName || idea.topMatchName || (a.vcFitScore > 80 ? 'High VC Interest' : '');
    var vcHighlight = '';
    if (vcMatch) {
      var matchPct = idea.dynamicMatchScore || a.vcFitScore || 100;
      vcHighlight = 
        '<div class="iv-vc-signal-highlight">' +
          '<div class="iv-vc-signal-label"><i class="fa-solid fa-bolt"></i> VC Signal</div>' +
          '<div class="iv-vc-signal-value">' + esc(vcMatch) + ' ~' + matchPct + '% fit</div>' +
          '<a href="/investors.html" class="iv-vc-signal-link">View in VC Section <i class="fa-solid fa-arrow-right"></i></a>' +
        '</div>';
    }

    // 4. Strategic Summary (3-4 sentences)
    var summaryText = idea.aiSummary || m.localStrategicSummary || idea.summary || 'Strategic overview pending analysis.';

    // 5. Details Grid (Problem/Solution)
    var problemHtml = '<div class="iv-card-detail-item prob"><strong>Problem</strong><p>' + esc(idea.problem || 'Not specified.') + '</p></div>';
    var solutionHtml = '<div class="iv-card-detail-item sol"><strong>Solution</strong><p>' + esc(idea.solution || 'Not specified.') + '</p></div>';

    // 6. Metadata (Customer, Tags, Link)
    var metaHtml = 
      '<div class="iv-card-meta-grid">' +
        '<div class="iv-card-meta-item"><strong>Target</strong><span>' + esc(idea.idealCustomer || 'General') + '</span></div>' +
        '<div class="iv-card-meta-item"><strong>Category</strong><span>' + esc(idea.category || 'Other') + '</span></div>' +
      '</div>';
    
    var tagsHtml = '';
    if (idea.tags && idea.tags.length) {
      tagsHtml = '<div class="iv-card-tags">' + idea.tags.map(function(t) { return '<span class="iv-tag">#' + esc(t) + '</span>'; }).join('') + '</div>';
    }

    var refLinkHtml = '';
    if (idea.referenceLink) {
      refLinkHtml = '<a href="' + esc(idea.referenceLink) + '" class="iv-card-ref-link"><i class="fa-solid fa-link"></i> Reference: ' + esc(idea.referenceLink) + '</a>';
    }

    var statsGridHtml = 
      '<div class="iv-card-ml-stats">' +
        '<div class="iv-ml-stat"><strong title="Relative trending rank based on overall traction">Trend Rank</strong>' + (m.hotRankScore != null ? m.hotRankScore : '—') + '</div>' +
        '<div class="iv-ml-stat"><strong title="Completeness of the idea\'s description and problem/solution">Detail Score</strong>' + (m.contentDepth != null ? m.contentDepth : '—') + '%</div>' +
        '<div class="iv-ml-stat"><strong title="Readiness for funding based on idea completeness">Investability</strong>' + (m.fundingReadiness != null ? m.fundingReadiness : '—') + '%</div>' +
        '<div class="iv-ml-stat"><strong title="Recent growth momentum in views">Growth Trend</strong>' + (m.trendVelocityPct != null ? m.trendVelocityPct + '%' : '—') + '</div>' +
      '</div>';

    // 7.5 Sparkline Chart Container
    var chartHtml = 
      '<div class="iv-card-sparkline-box">' +
        '<div class="iv-sparkline-header">' +
          '<span>7d Views</span>' +
          '<span class="iv-sparkline-val">' + (idea.views || 0) + '</span>' +
        '</div>' +
        '<canvas id="spark-chart-' + esc(String(idea._id)) + '" class="iv-card-sparkline-canvas"></canvas>' +
      '</div>';

    return (
      '<article class="iv-card-premium-v2 iv-fade-in" data-idea-id="' + esc(String(idea._id)) + '">' +
        '<div class="iv-card-header-strip">' + stripHtml + '</div>' +
        '<div class="iv-card-image-container">' +
          imgHtml +
          '<div class="iv-card-image-overlay"></div>' +
          '<div class="iv-card-badges-overlay">' +
            '<span class="iv-badge-cat">' + esc(idea.category || 'General') + '</span>' +
            (a.innovationScore != null ? '<span class="iv-badge-innov">Innov ' + a.innovationScore + '</span>' : '') +
          '</div>' +
          // Removed emoji overlay to prevent redundancy and inconsistencies
        '</div>' +
        
        '<div class="iv-card-main-content">' +
          '<h3 class="iv-card-title">' + esc(idea.title || '') + '</h3>' +
          vcHighlight +
          '<div class="iv-card-summary-box">' +
            '<strong><i class="fa-solid fa-robot"></i> AI/ML Summary</strong>' +
            '<p>' + esc(summaryText) + '</p>' +
          '</div>' +

          '<div class="iv-card-problem-solution-grid">' +
            problemHtml +
            solutionHtml +
          '</div>' +

          metaHtml +
          tagsHtml +
          chartHtml +
          refLinkHtml +
          statsGridHtml +

          '<div class="iv-card-engagement-row">' +
            '<span><i class="fa-solid fa-eye"></i> ' + (idea.views || 0) + '</span>' +
            '<span><i class="fa-solid fa-heart"></i> ' + (idea.likes || []).length + '</span>' +
            '<span><i class="fa-solid fa-comment"></i> ' + (idea.comments || []).length + '</span>' +
          '</div>' +

          '<div class="iv-card-footer-actions">' +
            '<div class="iv-card-creator-info">' +
              'By <a href="/profile.html?userId=' + creatorId + '">' + creatorName + '</a>' +
            '</div>' +
            '<div class="iv-card-btn-group">' +
              (opts.isInspired
                ? '<button type="button" class="iv-btn iv-btn-accent iv-btn-sm" data-build-similar-id="' +
                  esc(String(idea._id)) +
                  '"><i class="fa-solid fa-wand-magic-sparkles"></i> Build Similar</button>'
                : '') +
              (opts.isOwner ? '<button type="button" class="iv-btn iv-btn-accent iv-btn-sm" onclick="window.location.href=\'/investors.html?matchIdea=' + esc(String(idea._id)) + '\'"><i class="fa-solid fa-handshake"></i> Match VC</button>' : '') +
              '<button type="button" class="iv-btn iv-btn-ghost iv-btn-xs" onclick="checkAuthenticity(\'' + esc(String(idea._id)) + '\')"><i class="fa-solid fa-shield-halved"></i> Authenticity</button>' +
              '<button type="button" class="iv-btn iv-btn-secondary iv-btn-sm" data-read="' + esc(String(idea._id)) + '">Read</button>' +
              (opts.isInspired ? '' : '<button type="button" class="iv-btn iv-btn-primary iv-btn-sm" data-strat-open="' + esc(String(idea._id)) + '">Analyze</button>') +
            '</div>' +
          '</div>' +

          (opts.isVcDashboard
            ? '<div class="iv-card-contact-row">' +
              '<button type="button" class="iv-contact-btn" data-iv-contact-payload="' +
              encContactPayload(idea) +
              '"><i class="fa-solid fa-address-card"></i> Contact founder</button>' +
              '<button type="button" class="iv-contact-btn" style="background:var(--success);color:white;border-color:var(--success);box-shadow:0 2px 10px rgba(16,185,129,0.3)" onclick="window.location.href=\'/raise-funds.html?ideaId=' + esc(String(idea._id)) + '\'"><i class="fa-solid fa-indian-rupee-sign"></i> View Fundraiser / Pay</button>' +
              '<button type="button" class="iv-contact-btn" onclick="window.location.href=\'/api/ideas/' +
              esc(String(idea._id)) +
              '/report\'"><i class="fa-solid fa-file-pdf"></i> PDF Report</button>' +
              '</div>'
            : '') +
        '</div>' +
      '</article>'

    );
  }


  function initSparkline(id, history) {
    var canvas = document.getElementById('spark-chart-' + id);
    if (!canvas || typeof Chart === 'undefined') return;
    
    var labels = [];
    var data = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var key = d.toISOString().slice(0, 10);
      labels.push(d.toLocaleDateString(undefined, { weekday: 'short' }));
      var h = (history || []).find(function(x) { return new Date(x.date).toISOString().slice(0, 10) === key; });
      data.push(h ? h.count : 0);
    }

    new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          borderColor: '#3b82f6',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          fill: true,
          backgroundColor: 'rgba(59, 130, 246, 0.1)'
        }]
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { enabled: true } },
        scales: { x: { display: false }, y: { display: false } },
        maintainAspectRatio: false,
        responsive: true
      }
    });
  }

  global.IdeaVaultCard = {
    render: renderIdeaCard,
    initSparkline: initSparkline,
    encContactPayload: encContactPayload,
  };
})(window);
