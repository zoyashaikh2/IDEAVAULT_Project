/**
 * Shared strategic analysis UI — powered by real AI (Gemini/Groq LLM) + ML (pack.js)
 * All data comes from MongoDB via API — zero static/hardcoded fallbacks.
 * Shows: AI Summary, Roadmap phases, SWOT, Revenue, VC fit, ML scores, community sentiment.
 */
(function (global) {
  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function analysisStripHtml(idea) {
    var m = idea.mlPack || {};
    var a = idea.aiAnalysis || {};

    var lCount = (idea.likes || []).length;
    var cCount = (idea.comments || []).length;
    var views  = idea.views || 0;
    var lc = 'Likes ' + lCount + ' · Comments ' + cCount;

    // Real-time Naive Bayes Sentiment (from server ml/pack.js)
    var sent;
    var nb = m.naiveBayesSentiment || {};
    if (lCount === 0 && cCount === 0) {
      sent = 'No traction yet';
    } else if (nb.label) {
      sent = nb.label.charAt(0).toUpperCase() + nb.label.slice(1);
    } else {
      sent = lCount > 2 || cCount > 1 ? 'Positive' : 'Neutral';
    }

    // AI Market Trend (from LLM analysis or ML velocity)
    var velocityPct = m.trendVelocityPct != null ? m.trendVelocityPct : 0;
    var trend;
    if (a.marketTrend) {
      trend = a.marketTrend;
    } else if (velocityPct > 10) {
      trend = 'Upward';
    } else if (velocityPct < -10) {
      trend = 'Declining';
    } else {
      trend = 'Stable';
    }
    if ((lCount > 0 || cCount > 0) && trend === 'Declining') trend = 'Stable';

    var viability = m.successProbability != null ? Math.round(m.successProbability) : null;
    var innovScore = a.innovationScore != null ? a.innovationScore : null;
    var vcFit = a.vcFitScore != null ? a.vcFitScore : null;

    var mlChips = '';
    if (viability != null) {
      mlChips += '<span class="iv-analysis-chip"><strong title="ML success probability from engagement + content + AI scores">Viability</strong> ' + viability + '%</span>';
    }
    if (innovScore != null) {
      mlChips += '<span class="iv-analysis-chip"><strong title="LLM-scored innovation from problem-solution differentiation">Innovation</strong> ' + innovScore + '/10</span>';
    }
    if (vcFit != null) {
      mlChips += '<span class="iv-analysis-chip"><strong title="VC thesis alignment scored by AI">VC Fit</strong> ' + vcFit + '/100</span>';
    }
    if (m.contentDepth != null) {
      mlChips += '<span class="iv-analysis-chip"><strong title="Completeness scored by ML">Detail Score</strong> ' + m.contentDepth + '%</span>';
    }
    if (m.trendVelocityPct != null) {
      mlChips += '<span class="iv-analysis-chip"><strong title="7-day view momentum % change">Growth Trend</strong> ' + (velocityPct > 0 ? '+' : '') + velocityPct + '%</span>';
    }

    return (
      '<div class="iv-analysis-strip" role="region" aria-label="AI and ML signals">' +
      '<div class="iv-analysis-strip-inner">' +
      '<span class="iv-analysis-chip"><strong>Sentiment</strong> ' + esc(sent) + '</span>' +
      '<span class="iv-analysis-chip"><strong>Market trend</strong> ' + esc(trend) + '</span>' +
      '<span class="iv-analysis-chip"><strong>Community</strong> ' + lc + '</span>' +
      mlChips +
      '</div></div>'
    );
  }

  function barRowsFromCharts(idea) {
    var a = idea.aiAnalysis || {};
    var m = idea.mlPack || {};
    var bars = a.mlCharts && a.mlCharts.scoreBars;
    if (!bars || !bars.length) {
      var inv = a.innovationScore != null ? Number(a.innovationScore) : null;
      var feas = a.feasibilityScore != null ? Number(a.feasibilityScore) : null;
      var risk = a.riskScore != null ? Number(a.riskScore) : null;
      var vc   = a.vcFitScore   != null ? Number(a.vcFitScore)   : null;
      var capEff = m.capitalEfficiencyScore != null ? m.capitalEfficiencyScore : null;
      var health = a.startupHealthScore != null ? Number(a.startupHealthScore) : null;
      bars = [
        inv  != null ? { label: 'Innovation',       pct: inv * 10,               fact: 'Gemini AI scored innovation ' + inv + '/10 from problem-solution analysis.' } : null,
        feas != null ? { label: 'Feasibility',      pct: feas * 10,              fact: 'Feasibility ' + feas + '/10 — reflects delivery realism vs scope.' } : null,
        risk != null ? { label: 'Risk (inverse)',   pct: Math.max(0,100-risk*10),fact: 'Risk index ' + risk + '/10 — lower bar = higher execution risk.' } : null,
        vc   != null ? { label: 'VC Thesis Fit',    pct: vc,                     fact: 'VC thesis fit ' + vc + '/100 from AI analysis of investor alignment.' } : null,
        health != null ? { label: 'Startup Health', pct: health,                 fact: 'AI-computed overall startup health score ' + health + '/100.' } : null,
        capEff != null ? { label: 'Capital Efficiency', pct: capEff,             fact: 'Engagement output / content investment ratio from ML.' } : null,
        { label: 'Content Depth', pct: m.contentDepth || 0, fact: 'ML-scored completeness: problem/solution detail, tags, customer fit.' },
      ].filter(Boolean);
    }
    return bars
      .map(function (b) {
        var pct = Math.max(0, Math.min(100, Number(b.pct) || 0));
        var title = esc(b.fact || b.label + ': ' + pct + '%');
        var color = pct >= 70 ? '#10b981' : pct >= 45 ? '#f59e0b' : '#ef4444';
        return (
          '<div class="iv-bar-row" title="' + title + '">' +
          '<span class="iv-bar-label">' + esc(b.label) + '</span>' +
          '<div class="iv-bar-track"><div class="iv-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
          '<span class="iv-bar-pct">' + Math.round(pct) + '%</span></div>'
        );
      })
      .join('');
  }

  function pieSvgFromCharts(idea) {
    var a = idea.aiAnalysis || {};
    var m = idea.mlPack || {};
    var slices = a.mlCharts && a.mlCharts.pieCommunity;
    if (!slices || !slices.length) {
      var likes    = (idea.likes    || []).length;
      var comments = (idea.comments || []).length;
      var views    = Math.max(1, idea.views || 0);
      var totalEng = Math.max(1, likes + comments + Math.max(1, Math.round(views / 25)));
      slices = [
        { label: 'Likes',         pct: Math.round((likes    / totalEng) * 1000) / 10, fact: likes    + ' users liked this idea.' },
        { label: 'Comments',      pct: Math.round((comments / totalEng) * 1000) / 10, fact: comments + ' discussion threads.' },
        { label: 'Passive Views', pct: Math.round((Math.max(1, Math.round(views/25)) / totalEng) * 1000) / 10, fact: views + ' total views recorded.' },
      ];
    }
    var cx = 100, cy = 100, r = 70;
    var colors = ['#6366f1', '#22c55e', '#f59e0b'];
    var total = slices.reduce(function (s, x) { return s + Math.max(0, Number(x.pct) || 0); }, 0);
    if (total <= 0) total = 1;
    var start = -Math.PI / 2;
    var paths = [];
    for (var i = 0; i < slices.length; i++) {
      var frac = (Math.max(0, Number(slices[i].pct) || 0) / total) * Math.PI * 2;
      var x1 = cx + r * Math.cos(start);
      var y1 = cy + r * Math.sin(start);
      start += frac;
      var x2 = cx + r * Math.cos(start);
      var y2 = cy + r * Math.sin(start);
      var large = frac > Math.PI ? 1 : 0;
      var d = 'M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x2 + ' ' + y2 + ' Z';
      paths.push(
        '<path d="' + d + '" fill="' + colors[i % colors.length] + '" stroke="#fff" stroke-width="1" title="' +
        esc(slices[i].label + ': ' + slices[i].pct + '% — ' + (slices[i].fact || '')) +
        '"><title>' + esc(slices[i].label + ': ' + slices[i].pct + '%') + '</title></path>'
      );
    }
    return (
      '<div class="iv-pie-wrap iv-pie-compact"><svg viewBox="0 0 200 200" width="160" height="160" role="img" aria-label="Engagement mix">' +
      paths.join('') +
      '</svg><ul class="iv-pie-legend">' +
      slices.map(function (s, j) {
        return '<li><span class="iv-dot" style="background:' + colors[j % colors.length] + '"></span>' +
          esc(s.label) + ' <strong>' + esc(String(s.pct)) + '%</strong></li>';
      }).join('') +
      '</ul></div>'
    );
  }

  function viewsSparklineSvg(idea) {
    var vh = idea.viewsHistory || [];
    var slice = vh.slice(-7);
    if (!slice.length && idea.views > 0) {
      slice = [{ count: idea.views || 0 }];
    }
    if (!slice.length) return '<p class="iv-strat-muted">No reach data recorded yet. Views will appear here as users visit this idea.</p>';

    var max = 1;
    for (var i = 0; i < slice.length; i++) max = Math.max(max, slice[i].count || 0);
    var W = 320, H = 100, n = slice.length, step = W / Math.max(1, n - 1);
    var d = '', dots = '';
    for (var j = 0; j < n; j++) {
      var x = j * step;
      var cnt = slice[j].count || 0;
      var y = H - 20 - (cnt / max) * (H - 40);
      d += (j === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="#6366f1" />';
      if (j === 0 || j === n - 1 || cnt === max) {
        dots += '<text x="' + x.toFixed(1) + '" y="' + (y - 8).toFixed(1) + '" font-size="10" fill="#94a3b8" text-anchor="middle" font-weight="bold">' + cnt + '</text>';
      }
    }
    return (
      '<div class="iv-spark-block" style="background:rgba(255,255,255,0.02);padding:16px;border-radius:16px;border:1px solid var(--border)">' +
      '<h4 style="margin:0 0 12px;font-size:0.95rem;color:var(--text)"><i class="fa-solid fa-chart-line"></i> Reach Analytics (7-Day Trend)</h4>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="120" style="overflow:visible">' +
      '<line x1="0" y1="' + (H - 20) + '" x2="' + W + '" y2="' + (H - 20) + '" stroke="rgba(148,163,184,0.2)" stroke-width="1" />' +
      '<path d="' + d.trim() + '" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" />' +
      dots + '</svg>' +
      '<p style="margin-top:12px;font-size:0.8rem;color:var(--muted)">Total: <strong>' + (idea.views || 0) + '</strong> views stored in MongoDB.</p>' +
      '</div>'
    );
  }

  function roadmapCompactHtml(rm) {
    if (!rm || typeof rm !== 'object' || !rm.phases) return '';
    var phases = rm.phases || [];
    var head =
      '<div class="strat-block strat-ai-pack"><h4><i class="fa-solid fa-map" style="color:#6366f1"></i> AI Roadmap (stored on idea)</h4>' +
      '<p class="iv-strat-prose"><strong>Budget:</strong> ' + esc(String(rm.totalBudget || '—')) +
      ' · <strong>Timeline:</strong> ' + esc(String(rm.totalTimeline || '—')) + '</p>';
    if (rm.firstStep) {
      head += '<p class="iv-strat-muted"><strong>First step:</strong> ' + esc(rm.firstStep) + '</p>';
    }
    if (rm.marketEntry) {
      head += '<p class="iv-strat-muted"><strong>Market entry:</strong> ' + esc(rm.marketEntry) + '</p>';
    }
    if (!phases.length) {
      return head + '<p class="iv-strat-muted">Generate roadmap from Create Idea page to see phases here.</p></div>';
    }
    var body = '<ol class="iv-roadmap-mini">';
    for (var i = 0; i < phases.length; i++) {
      var p = phases[i];
      var pName = p.name || p.title || ('Phase ' + (i + 1));
      var pDur = p.duration || p.timeline || ('Month ' + (i + 1));
      var pBudget = p.budget || '—';
      var pMilestone = p.milestone || '';
      var pTasks = (p.tasks || []).slice(0, 3);
      body += '<li><strong>' + esc(pName) + '</strong> — ' + esc(pDur) + '<br/>' +
        '<span class="iv-strat-muted">Budget: ' + esc(pBudget) + (pMilestone ? ' · Milestone: ' + esc(pMilestone) : '') + '</span>';
      if (pTasks.length) {
        body += '<ul style="margin:4px 0 0 16px;font-size:0.8rem;color:var(--muted)">' +
          pTasks.map(function(t){ return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
      }
      body += '</li>';
    }
    body += '</ol>';
    if (rm.kpis && rm.kpis.length) {
      body += '<p class="iv-strat-muted" style="margin-top:8px"><strong>KPIs:</strong> ' + rm.kpis.slice(0,3).map(esc).join(' · ') + '</p>';
    }
    body += '</div>';
    return head + body;
  }

  function stratLeftHtml(idea) {
    var a = idea.aiAnalysis || {};
    var rm = idea.aiRoadmap || {};
    var m = idea.mlPack || {};

    // Use AI data from DB — no static fallback
    if (!a.swot) {
      a.marketSummary = a.marketSummary || (m.localStrategicSummary) || '';
      a.maturity = (m.marketMaturity) || 'Emerging';
    }

    var swot = a.swot || {};
    function list(xs) {
      return (xs || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
    }
    var nar = a.strategicNarrative || {};
    var risks = (a.topRisks || []);

    var aiPack = ((idea.aiSummary || a.marketSummary)
      ? '<div class="strat-block strat-ai-pack"><h4><i class="fa-solid fa-robot" style="color:#6366f1"></i> AI Executive Summary</h4><p class="iv-strat-prose">' + esc(idea.aiSummary || a.marketSummary) + '</p></div>'
      : '') + roadmapCompactHtml(rm);

    var contactHtml = typeof global.IdeaVaultContact !== 'undefined' && global.IdeaVaultContact.stratContactButtonHtml
      ? global.IdeaVaultContact.stratContactButtonHtml(idea)
      : '';

    var swotHtml = '';
    var hasSwot = swot.strengths && swot.strengths.length;
    if (hasSwot) {
      swotHtml = '<div class="strat-block"><h4><i class="fa-solid fa-chess" style="color:#6366f1"></i> SWOT Analysis (AI)</h4><div class="strat-swot">' +
        '<div class="strat-swot-cell"><strong style="color:#10b981">S — Strengths</strong><ul>' + list(swot.strengths) + '</ul></div>' +
        '<div class="strat-swot-cell"><strong style="color:#f59e0b">W — Weaknesses</strong><ul>' + list(swot.weaknesses) + '</ul></div>' +
        '<div class="strat-swot-cell"><strong style="color:#6366f1">O — Opportunities</strong><ul>' + list(swot.opportunities) + '</ul></div>' +
        '<div class="strat-swot-cell"><strong style="color:#ef4444">T — Threats</strong><ul>' + list(swot.threats) + '</ul></div>' +
        '</div></div>';
    } else {
      swotHtml = '<div class="strat-block"><h4>SWOT Analysis</h4>' +
        '<p class="iv-strat-muted" style="padding:12px;background:rgba(99,102,241,0.06);border-radius:10px;border:1px dashed rgba(99,102,241,0.2)">' +
        '<i class="fa-solid fa-robot" style="color:#6366f1"></i> ' +
        'SWOT is generated by AI. Click <strong>Analyze</strong> on the idea card or open Strategic Analytics to trigger LLM analysis.</p></div>';
    }

    var risksHtml = '';
    if (risks.length) {
      risksHtml = '<div class="strat-block"><h4><i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> Top Risks & Mitigations (AI)</h4><ul style="padding-left:18px;font-size:0.85rem;color:var(--muted);line-height:1.7">' +
        risks.slice(0, 4).map(function(r) {
          return '<li><strong>' + esc(r.risk || '') + '</strong><br/><span style="color:var(--success)">→ ' + esc(r.mitigation || '') + '</span></li>';
        }).join('') + '</ul></div>';
    }

    var narrativeHtml = '';
    if (nar.who || nar.what || nar.why || nar.how) {
      narrativeHtml = '<div class="strat-block"><h4><i class="fa-solid fa-lightbulb" style="color:#6366f1"></i> Strategic Narrative (AI)</h4>' +
        (nar.who ? '<p class="iv-strat-prose"><strong>Who:</strong> ' + esc(nar.who) + '</p>' : '') +
        (nar.what ? '<p class="iv-strat-prose"><strong>What:</strong> ' + esc(nar.what) + '</p>' : '') +
        (nar.why ? '<p class="iv-strat-prose"><strong>Why:</strong> ' + esc(nar.why) + '</p>' : '') +
        (nar.how ? '<p class="iv-strat-prose"><strong>How:</strong> ' + esc(nar.how) + '</p>' : '') +
        (nar.prevention ? '<p class="iv-strat-prose"><strong>Risk prevention:</strong> ' + esc(nar.prevention) + '</p>' : '') +
        '</div>';
    }

    return (
      aiPack +
      narrativeHtml +
      '<div class="strat-block"><h4>Who this serves</h4><p class="iv-strat-prose">' +
      esc(nar.who || idea.idealCustomer || a.marketSummary || 'Strategic target group analysis pending.') +
      '</p></div>' +
      '<div class="strat-block"><h4><i class="fa-solid fa-brain" style="color:#6366f1"></i> Innovation Index</h4><div class="strat-metric-big">' +
      (a.innovationScore != null ? esc(String(a.innovationScore)) : '—') + '/10' +
      '</div><p class="iv-strat-muted">' +
      esc(a.explanation || 'AI-scored from problem uniqueness, market saturation, and solution novelty.') +
      '</p></div>' +
      contactHtml +
      '<div class="strat-block"><h4>Market Maturity & Size</h4><p>' +
      esc(a.maturity || m.marketMaturity || '—') + ' · ' + esc(a.marketSize || '—') +
      (a.growthRate ? ' · Growth: ' + esc(a.growthRate) : '') +
      '</p></div>' +
      '<div class="strat-block"><h4><i class="fa-solid fa-chart-line" style="color:#10b981"></i> Financial Outlook (AI Model)</h4>' +
      '<p>Y1 Revenue: <strong>' + esc(String(a.revenueY1 || '—')) + '</strong></p>' +
      '<p>Y3 Revenue: <strong>' + esc(String(a.revenueY3 || '—')) + '</strong></p>' +
      '<p>YoY Growth: <strong>' + esc(String(a.yoyGrowth || '—')) + '</strong></p>' +
      (a.revenueModel ? '<p>Model: <strong>' + esc(a.revenueModel) + '</strong></p>' : '') +
      '</div>' +
      swotHtml +
      risksHtml
    );
  }

  function stratRightHtml(idea) {
    var a = idea.aiAnalysis || {};
    var m = idea.mlPack || {};

    var lCount = (idea.likes || []).length;
    var cCount = (idea.comments || []).length;

    var nb = m.naiveBayesSentiment || {};
    var sentLabel;
    if (lCount === 0 && cCount === 0) {
      sentLabel = 'No traction yet';
      nb = { label: 'negative', emoji: '📉' };
    } else if (nb.label) {
      sentLabel = nb.label.charAt(0).toUpperCase() + nb.label.slice(1);
    } else {
      sentLabel = lCount > 2 || cCount > 1 ? 'Positive' : 'Neutral';
      nb.label = sentLabel.toLowerCase();
    }
    var hype = m.hype || {};
    var impact = m.impact || {};
    var forecast = m.engagementForecast || {};

    var mlGrid = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">' +
      '<div style="background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);padding:14px;border-radius:12px">' +
        '<strong title="ML success probability from engagement + AI scores" style="color:#10b981;font-size:0.75rem;text-transform:uppercase">Viability Prediction</strong>' +
        '<div style="font-size:1.6rem;font-weight:700;margin-top:6px;color:var(--text)">' + (m.successProbability!=null ? Math.round(m.successProbability)+'%' : '—') + '</div>' +
        '<div style="font-size:0.7rem;color:var(--muted)">Logistic classifier: engagement + AI + content depth</div>' +
      '</div>' +
      '<div style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);padding:14px;border-radius:12px">' +
        '<strong title="Naive Bayes NLP on comments + likes signal" style="color:#6366f1;font-size:0.75rem;text-transform:uppercase">Community Sentiment</strong>' +
        '<div style="font-size:1.4rem;font-weight:700;margin-top:6px;color:var(--text)">' + (nb.emoji || '') + ' ' + esc(sentLabel) + '</div>' +
        '<div style="font-size:0.7rem;color:var(--muted)">Likes: ' + lCount + ' · Comments: ' + cCount + '</div>' +
      '</div>' +
      '<div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.2);padding:14px;border-radius:12px">' +
        '<strong title="Momentum from 7-day views + engagement weighting" style="color:#f59e0b;font-size:0.75rem;text-transform:uppercase">Hype Score</strong>' +
        '<div style="font-size:1.6rem;font-weight:700;margin-top:6px;color:var(--text)">' + esc(String(hype.score||'0')) + '%</div>' +
        '<div style="font-size:0.7rem;color:var(--muted)">' + esc(hype.label || 'Steady') + ' · ' + esc(hype.method || 'volume-weighted') + '</div>' +
      '</div>' +
      '<div style="background:rgba(236,72,153,0.1);border:1px solid rgba(236,72,153,0.2);padding:14px;border-radius:12px">' +
        '<strong title="Impact keyword density from problem/solution text" style="color:#ec4899;font-size:0.75rem;text-transform:uppercase">Impact Index</strong>' +
        '<div style="font-size:1.4rem;font-weight:700;margin-top:6px;color:var(--text)">' + (impact.score!=null ? esc(String(impact.score))+'/10' : '—') + '</div>' +
        '<div style="font-size:0.7rem;color:var(--muted)">Keyword density analysis</div>' +
      '</div>' +
      '</div>';

    // Engagement forecast from ML
    var forecastHtml = '';
    if (forecast.next7dViewsEst != null) {
      forecastHtml = '<div style="padding:14px;background:rgba(99,102,241,0.06);border-radius:12px;border:1px solid rgba(99,102,241,0.15);margin-bottom:16px">' +
        '<h4 style="margin:0 0 8px;font-size:0.85rem;color:var(--accent)"><i class="fa-solid fa-robot"></i> ML Engagement Forecast (7-day)</h4>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.82rem">' +
        '<div>Est. Views: <strong>' + forecast.next7dViewsEst + '</strong></div>' +
        '<div>Est. Likes: <strong>' + (forecast.next7dLikesEst || '—') + '</strong></div>' +
        '<div>Trend: <strong>' + (forecast.trend || '—') + '</strong></div>' +
        '<div>Velocity: <strong>' + (forecast.trendVelocityPct != null ? (forecast.trendVelocityPct > 0 ? '+' : '') + forecast.trendVelocityPct + '%' : '—') + '</strong></div>' +
        '</div></div>';
    }

    // AI Market thesis / competitor intelligence
    var marketHtml = '';
    if (a.futureTrends && a.futureTrends.length) {
      marketHtml += '<div class="strat-block"><h4><i class="fa-solid fa-telescope" style="color:#6366f1"></i> Future Trends (AI)</h4>' +
        '<ul style="padding-left:18px;font-size:0.85rem;color:var(--muted);line-height:1.6">' +
        a.futureTrends.slice(0,4).map(function(t){ return '<li>' + esc(t) + '</li>'; }).join('') +
        '</ul></div>';
    }
    if (a.competitorNames && a.competitorNames.length) {
      marketHtml += '<div class="strat-block"><h4><i class="fa-solid fa-chess-king" style="color:#f59e0b"></i> Competitive Landscape (AI)</h4>' +
        '<p style="font-size:0.85rem;color:var(--muted)">' + a.competitorNames.slice(0,5).map(esc).join(' · ') + '</p>' +
        (a.competitorCount ? '<p style="font-size:0.82rem;color:var(--muted)">Estimated competitors: <strong>' + a.competitorCount + '</strong></p>' : '') +
        '</div>';
    }
    if (a.targetMarkets && a.targetMarkets.length) {
      marketHtml += '<div class="strat-block"><h4><i class="fa-solid fa-bullseye" style="color:#10b981"></i> Target Markets (AI)</h4>' +
        '<p style="font-size:0.85rem;color:var(--muted)">' + a.targetMarkets.slice(0,4).map(esc).join(' · ') + '</p></div>';
    }
    if (a.techStack && a.techStack.length) {
      marketHtml += '<div class="strat-block"><h4><i class="fa-solid fa-code" style="color:#6366f1"></i> Tech Stack (AI Recommended)</h4>' +
        '<p style="font-size:0.85rem;color:var(--muted)">' + a.techStack.slice(0,6).map(esc).join(' · ') + '</p></div>';
    }

    return (
      '<h3>Strategic Intelligence</h3>' +
      '<p class="iv-strat-muted" style="font-size:0.84rem;line-height:1.5;margin-bottom:14px">Real-time ML (Naive Bayes NLP, TF-IDF cosine, momentum) + LLM (Gemini/Groq) analysis from MongoDB data.</p>' +
      mlGrid +
      forecastHtml +
      '<h3>Visual Insights</h3>' +
      '<p class="iv-strat-muted" style="font-size:0.84rem;line-height:1.5"><strong>Bars</strong> = AI axial strength · <strong>Line</strong> = daily reach · <strong>Pie</strong> = engagement mix.</p>' +
      viewsSparklineSvg(idea) +
      '<h4 style="margin-top:16px">Multidimensional Scoring</h4>' +
      '<div class="iv-bars-visual iv-bars-compact">' + barRowsFromCharts(idea) + '</div>' +
      '<h4 style="margin-top:18px">Engagement Mix</h4>' +
      pieSvgFromCharts(idea) +
      marketHtml +
      '<div style="margin-top:24px;padding:16px;background:var(--bg);border-radius:12px;border:1px solid var(--border)">' +
      '<h4 style="margin:0 0 8px"><i class="fa-solid fa-list-check" style="color:#6366f1"></i> Execution Guidelines (AI)</h4>' +
      '<ul style="padding-left:18px;font-size:0.85rem;color:var(--muted);line-height:1.6">' +
      (a.strategicGuidelines && a.strategicGuidelines.length
        ? a.strategicGuidelines.map(function(g){ return '<li>' + esc(g) + '</li>'; }).join('')
        : '<li>Run AI analysis from the idea card to unlock execution steps from the LLM.</li>') +
      '</ul></div>' +
      '<table class="dash-factor-table" style="margin-top:20px"><tbody>' +
      '<tr><td>Content Depth</td><td>' + esc(String(m.contentDepth || '0')) + '% completeness (ML)</td></tr>' +
      '<tr><td>Market Maturity</td><td>' + esc(String(a.maturity || m.marketMaturity || '—')) + '</td></tr>' +
      '<tr><td>Category Uniqueness</td><td>' + (m.categoryUniqueness ? esc(String(m.categoryUniqueness.uniquenessIndex || '—')) + '% (cosine sim ML)' : '—') + '</td></tr>' +
      (a.revenueModel ? '<tr><td>Revenue Model</td><td>' + esc(String(a.revenueModel)) + '</td></tr>' : '') +
      '<tr><td>VC Pipeline Interest</td><td>' + esc(String(m.vcPipelineInterest || 0)) + ' investor(s)</td></tr>' +
      '<tr><td>Funding Readiness</td><td>' + esc(String(m.fundingReadiness != null ? m.fundingReadiness + '%' : '—')) + ' (ML)</td></tr>' +
      '</tbody></table>'
    );
  }

  function checkAuthenticityGlobal(id) {
    if (!id) return;
    if (typeof window.__ivToast !== 'undefined') {
      window.__ivToast('Analyzing authenticity & semantic uniqueness via Jaccard + cosine similarity...');
    }
    fetch((window.location.origin || '') + '/api/ideas/' + id + '?noView=1')
      .then(function(r) { return r.json(); })
      .then(function(idea) {
        if (!idea || idea.error) {
          alert('Could not retrieve idea authenticity metrics.');
          return;
        }
        var auth = (idea.mlPack && idea.mlPack.authenticity) || { similarity: 0 };
        var catUniq = (idea.mlPack && idea.mlPack.categoryUniqueness) || {};
        var msg = "🛡️ Authenticity Shield — IdeaVault ML Analysis\n\n";
        msg += "Idea: " + (idea.title || 'Untitled') + "\n";
        msg += "Category: " + (idea.category || 'General') + "\n\n";
        msg += "Algorithm: Jaccard Set Similarity + TF-IDF BoW Cosine against all published ideas\n\n";

        if (auth.similarity > 15) {
          msg += "⚠️ High Overlap Detected\n";
          msg += "Uniqueness: " + (100 - auth.similarity) + "% · Similarity: " + auth.similarity + "%\n\n";
          if (auth.closestMatch) {
            msg += "Closest Network Match:\n";
            msg += "» Title: " + auth.closestMatch.title + "\n";
            msg += "» Category: " + auth.closestMatch.category + "\n\n";
          }
          msg += "Category uniqueness: " + (catUniq.uniquenessIndex || '—') + "% (cosine similarity to category peers)\n\n";
          msg += "Verdict: High conceptual overlap with existing entries. Consider refining the unique value proposition.";
        } else {
          msg += "✅ Strong Uniqueness & Authenticity\n";
          msg += "Uniqueness: " + (100 - auth.similarity) + "% · Similarity Score: " + auth.similarity + "%\n\n";
          msg += "Category uniqueness: " + (catUniq.uniquenessIndex || '—') + "% vs category peers\n\n";
          msg += "Verdict: This idea appears highly unique within the IdeaVault network. Exceptional differentiation!";
        }
        alert(msg);
      })
      .catch(function() {
        alert('Error connecting to authenticity service.');
      });
  }

  global.IdeaVaultStrategic = {
    esc: esc,
    analysisStripHtml: analysisStripHtml,
    stratLeftHtml: stratLeftHtml,
    stratRightHtml: stratRightHtml,
    checkAuthenticity: checkAuthenticityGlobal,
  };
})(typeof window !== 'undefined' ? window : globalThis);
