/**
 * Lightweight on-device ML for IdeaVault — fully deterministic, no API calls.
 * Lexicon Naive Bayes on comments, BoW cosine vs category peers,
 * Jaccard authenticity, momentum forecast from viewsHistory.
 * ALL metrics are seeded from idea content — stable across refreshes.
 */

'use strict';

const CATEGORY_MARKET_MATURITY = {
  'AI/ML': 'Early Growth', 'SaaS': 'Growth', 'FinTech': 'Mature', 'EdTech': 'Early Growth',
  'HealthTech': 'Emerging', 'AgriTech': 'Emerging', 'E-commerce': 'Mature',
  'Real Estate': 'Mature', 'Social Impact': 'Emerging', 'Web3': 'Early', 'CleanTech': 'Early Growth',
  'General': 'Varies',
};

const CATEGORY_FEASIBILITY_BASE = {
  'SaaS': 7, 'AI/ML': 7, 'FinTech': 6, 'EdTech': 7, 'HealthTech': 6,
  'E-commerce': 7, 'Web3': 5, 'AgriTech': 6, 'CleanTech': 6, 'General': 5, 'Social Impact': 6,
};

const POS = new Set([
  'great', 'good', 'love', 'excellent', 'amazing', 'solid', 'yes', 'helpful', 'strong', 'growth',
  'promising', 'agree', 'useful', 'clear', 'win', 'best', 'nice', 'wow', 'thanks', 'invest',
  'persuasive', 'innovative', 'unique', 'scalable', 'brilliant', 'superb', 'outstanding', 'perfect',
  'fantastic', 'stunning', 'incredible', 'impressive', 'valuable', 'exceptional', 'robust',
  'compelling', 'visionary', 'breakthrough', 'disruptive', 'profitable', 'lucrative', 'traction',
  'momentum', 'stellar', 'terrific', 'marvelous', 'genius', 'smart', 'clever', 'insightful',
  'phenomenal', 'revolutionary', 'transformative', 'thriving', 'booming', 'viable', 'feasible',
  'practical', 'sustainable', 'agile',
]);
const NEG = new Set([
  'bad', 'worry', 'risk', 'unclear', 'vague', 'boring', 'fail', 'doubt', 'never', 'problem',
  'expensive', 'hard', 'difficult', 'competitor', 'scam', 'weak', 'confused', 'saturated',
  'terrible', 'awful', 'horrible', 'poor', 'flawed', 'useless', 'pointless', 'waste', 'stupid',
  'nonsense', 'ridiculous', 'impossible', 'unrealistic', 'doomed', 'garbage', 'trash', 'joke',
  'mess', 'disaster', 'failing', 'declining', 'stagnant', 'losing', 'lost', 'broken', 'dead',
  'unprofitable', 'unviable', 'impractical', 'unsustainable', 'fragile', 'vulnerable', 'risky',
  'complex', 'convoluted', 'flaw', 'glitch', 'bug', 'error', 'mistake', 'failure',
]);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function termFreq(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

function addTokensToTf(target, text) {
  for (const t of tokenize(text)) target[t] = (target[t] || 0) + 1;
}

function cosineTf(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of Object.keys(a)) na += a[k] * a[k];
  for (const k of Object.keys(b)) nb += b[k] * b[k];
  na = Math.sqrt(na) || 1e-9;
  nb = Math.sqrt(nb) || 1e-9;
  for (const k of Object.keys(a)) {
    if (b[k]) dot += a[k] * b[k];
  }
  return dot / (na * nb);
}

function naiveBayesFromComments(comments, ideaText, likes) {
  const numComments = (comments || []).length;
  const numLikes = (likes || []).length;

  if (numComments === 0 && numLikes === 0) {
    return {
      label: 'negative',
      emoji: '📉',
      probabilities: { positive: 0, negative: 100, neutral: 0 },
      model: 'engagement-heuristic',
      nComments: 0,
    };
  }

  let posC = 1 + numLikes * 3; // Boost positive based on likes
  let negC = 1;
  let neuC = 1;
  // Include title/problem in sentiment corpus for ideas with few/no comments
  const allTexts = [...(comments || []).map((c) => String(c.text || '')), ideaText || ''];
  for (const txt of allTexts) {
    const words = tokenize(txt);
    let hit = false;
    for (const w of words) {
      if (POS.has(w)) { posC += 2; hit = true; }
      else if (NEG.has(w)) { negC += 2; hit = true; }
    }
    if (!hit) neuC += 1;
  }
  const tot = posC + negC + neuC;
  const pp = posC / tot;
  const pn = negC / tot;
  const pz = neuC / tot;
  let label = 'neutral';
  if (pp > pn && pp > pz) label = 'positive';
  else if (pn > pp && pn > pz) label = 'negative';
  return {
    label,
    emoji: label === 'positive' ? '🚀' : label === 'negative' ? '📉' : '😐',
    probabilities: {
      positive: Math.round(pp * 1000) / 10,
      negative: Math.round(pn * 1000) / 10,
      neutral: Math.round(pz * 1000) / 10,
    },
    model: 'multinomial-lexicon-naive-bayes-v2',
    nComments: numComments,
  };
}

function calculateHypeScore(idea) {
  const vh = idea.viewsHistory || [];
  const last7 = vh.slice(-7).reduce((a, b) => a + (b.count || 0), 0);
  const total = Math.max(1, idea.views || 1);
  const likes = (idea.likes || []).length;
  const comments = (idea.comments || []).length;

  // Recency ratio: what fraction of all-time views came in last 7 days
  const recency = last7 / total;

  // Absolute engagement signal (raw traction)
  const engRaw = likes * 3 + comments * 5 + Math.min(30, last7 * 0.3);

  // Volume penalty: ideas with very few total views are NOT viral
  // log10(55) / 2.5 ≈ 0.69 — dampens score for low-view ideas
  const volumePenalty = Math.min(1, Math.log10(Math.max(2, total)) / 2.5);

  const raw = (recency * 40 + engRaw * 2) * volumePenalty;
  const score = Math.min(100, Math.round(raw));
  return {
    score,
    label: score > 75 ? 'Viral' : score > 45 ? 'Trending' : 'Steady',
    method: 'volume-weighted-growth-engagement-momentum',
  };
}

function calculateImpactScore(idea) {
  const text = tokenize(`${idea.title} ${idea.problem} ${idea.solution}`).join(' ');
  const impactWords = ['global', 'million', 'billion', 'transform', 'solve', 'climate', 'health', 'education', 'efficiency', 'automate', 'scale', 'enterprise'];
  let count = 0;
  impactWords.forEach((w) => { if (text.includes(w)) count++; });
  return {
    score: Math.min(10, 3 + count),
    method: 'impact-keyword-density',
  };
}

function engagementForecast(idea) {
  const vh = idea.viewsHistory || [];
  const last7 = vh.slice(-7).map((h) => h.count || 0);
  const avg = last7.length ? last7.reduce((a, b) => a + b, 0) / last7.length : (idea.views || 0) / 14;
  const likes = (idea.likes || []).length;
  const comments = (idea.comments || []).length;
  const views = idea.views || 0;
  const estViews = Math.max(0, Math.round(avg * 7 * 1.1 + comments * 5));
  const estLikes = Math.round(likes * 1.12 + comments * 0.2);
  const trend = estViews > views * 0.08 ? 'up' : 'flat';

  // Trend velocity: % change in views between first half and second half of viewsHistory
  const recentSlice = vh.slice(-14);
  const half = Math.floor(recentSlice.length / 2);
  const firstHalf = recentSlice.slice(0, half).reduce((a, b) => a + (b.count || 0), 0);
  const secondHalf = recentSlice.slice(half).reduce((a, b) => a + (b.count || 0), 0);
  
  let velocityPct = 0;
  if (firstHalf > 0) {
    velocityPct = Math.round(((secondHalf - firstHalf) / firstHalf) * 100);
    // Stabilize wild swings for very low view counts
    if (firstHalf + secondHalf < 20 && velocityPct < -10) {
      velocityPct = 0; // Prevent drastic negative percentages on trivially small numbers
    }
  }
  return {
    next7dViewsEst: estViews,
    next7dLikesEst: estLikes,
    trend,
    trendVelocityPct: velocityPct,
    method: '7d-views-momentum-v2',
  };
}

function categoryUniqueness(idea, peerTfMerged) {
  const ideaTf = termFreq(tokenize(`${idea.title || ''} ${idea.problem || ''} ${idea.solution || ''}`));
  if (!peerTfMerged || !Object.keys(peerTfMerged).length) return { uniquenessIndex: 85, method: 'heuristic-default' };
  const sim = cosineTf(ideaTf, peerTfMerged);
  const uniqueness = Math.round((1 - Math.min(1, sim * 1.15)) * 100);
  return {
    cosineSimilarityToCategoryPeers: Math.round(sim * 1000) / 1000,
    uniquenessIndex: Math.max(0, Math.min(100, uniqueness)),
    method: 'bag-of-words-cosine-vs-category-peers',
  };
}

function successProbability(idea, investmentCount) {
  const likes = (idea.likes || []).length;
  const comments = (idea.comments || []).length;
  const views = Math.max(1, idea.views || 1);
  const inv = idea.aiAnalysis || {};
  const innov = Number(inv.innovationScore) || 5;
  const feas = Number(inv.feasibilityScore) || 5;
  const vcFit = Number(inv.vcFitScore) || 50;
  const eng = Math.min(40, ((likes + comments * 3) / views) * 100);
  const invC = Number(investmentCount) || 0;
  let raw =
    innov * 4.5 + feas * 3.5 + vcFit * 0.3 + eng * 0.6 +
    Math.min(25, invC * 5) + Math.min(20, comments * 3) + Math.min(15, likes * 1);
  return Math.max(5, Math.min(98, Math.round(raw * 0.8)));
}

/**
 * Deterministic feasibility heuristic — stable across refreshes.
 * Weighted factors: category base, problem/solution depth, reference link, tags.
 */
function feasibilityHeuristic(idea) {
  const catBase = CATEGORY_FEASIBILITY_BASE[idea.category] || 5;
  const probBonus = Math.min(2, Math.round((idea.problem || '').length / 150));
  const solBonus = Math.min(2, Math.round((idea.solution || '').length / 200));
  const refBonus = idea.referenceLink ? 1 : 0;
  const tagsBonus = (idea.tags && idea.tags.length > 1) ? 0.5 : 0;
  return Math.max(1, Math.min(10, Math.round(catBase + probBonus + solBonus + refBonus + tagsBonus)));
}

function peerTfExcluding(ideas, self) {
  const cat = self.category || '_uncat';
  const merged = {};
  for (const o of ideas) {
    if (String(o._id) === String(self._id)) continue;
    if ((o.category || '_uncat') !== cat) continue;
    if (o.status !== 'Published') continue;
    addTokensToTf(merged, `${o.title || ''} ${o.problem || ''} ${o.solution || ''}`);
  }
  return merged;
}

function jaccardSimilarity(textA, textB) {
  const setA = new Set(tokenize(textA));
  const setB = new Set(tokenize(textB));
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

function findTopOverlap(idea, peers) {
  let maxSim = 0;
  let closest = null;
  const selfText = `${idea.title} ${idea.problem} ${idea.solution}`;
  for (const peer of peers) {
    if (String(peer._id) === String(idea._id)) continue;
    const peerText = `${peer.title} ${peer.problem} ${peer.solution}`;
    const sim = jaccardSimilarity(selfText, peerText);
    if (sim > maxSim) { maxSim = sim; closest = peer; }
  }
  return {
    similarity: Math.round(maxSim * 100),
    closestMatch: closest ? { id: closest._id, title: closest.title, category: closest.category } : null,
  };
}

/**
 * TF-IDF extractive summarizer — picks 3-4 most informative sentences.
 * Returns a local summary when AI is unavailable or not yet generated.
 */
function localSummarize(text, numSentences) {
  numSentences = numSentences || 3;
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  if (sentences.length <= numSentences) return text.trim();
  const words = tokenize(text);
  const tf = termFreq(words);
  const scoredSentences = sentences.map((sentence, index) => {
    const sWords = tokenize(sentence);
    let score = 0;
    for (const w of sWords) score += (tf[w] || 0);
    if (index === 0) score *= 1.5;
    return { sentence: sentence.trim(), score, index };
  });
  scoredSentences.sort((a, b) => b.score - a.score);
  const top = scoredSentences.slice(0, numSentences).sort((a, b) => a.index - b.index);
  return top.map((s) => s.sentence).join(' ');
}

/**
 * Capital efficiency: how much output (views+engagement) per unit of "content investment".
 * Pure math — stable metric.
 */
function capitalEfficiencyScore(idea) {
  const contentScore = Math.max(1,
    (idea.problem || '').length + (idea.solution || '').length + (idea.title || '').length
  );
  const outputScore = (idea.views || 0) * 1 + (idea.likes || []).length * 15 + (idea.comments || []).length * 20;
  return Math.min(100, Math.round((outputScore / contentScore) * 100));
}

/**
 * @param {object} idea — lean or plain object
 * @param {{ investmentCount?: number, publishedPeers?: object[] }} ctx
 */
function buildMlPack(idea, ctx) {
  ctx = ctx || {};
  const invC = ctx.investmentCount || 0;
  const peers = ctx.publishedPeers || [];
  const peerTf = peerTfExcluding(peers, idea);
  const ideaText = `${idea.title || ''} ${idea.problem || ''} ${idea.solution || ''}`;
  const nb = naiveBayesFromComments(idea.comments, ideaText, idea.likes);
  const forecast = engagementForecast(idea);
  const success = successProbability(idea, invC);
  const hype = calculateHypeScore(idea);
  const impact = calculateImpactScore(idea);
  const authenticity = findTopOverlap(idea, peers);
  const fundExtra = idea.fundraising && Number(idea.fundraising.raisedUsd) > 0 ? 12 : 0;
  const fundingReadiness = Math.min(100, Math.round(success * 0.95 + fundExtra));
  const uniq = categoryUniqueness(idea, peerTf);
  const swot = idea.aiAnalysis && idea.aiAnalysis.swot ? idea.aiAnalysis.swot : null;
  const feas = feasibilityHeuristic(idea);
  const capEff = capitalEfficiencyScore(idea);

  const contentDepth = Math.min(100, Math.round((
    Math.min(1, (idea.problem || '').length / 300) * 35 +
    Math.min(1, (idea.solution || '').length / 300) * 35 +
    Math.min(1, (idea.title || '').length / 80) * 10 +
    (idea.idealCustomer ? 10 : 0) +
    (idea.tags && idea.tags.length ? 5 : 0) +
    (idea.referenceLink ? 5 : 0)
  )));

  // Determine market trend from viewsHistory slope + AI analysis fallback
  let marketTrend = 'Steady';
  if (idea.aiAnalysis && idea.aiAnalysis.marketTrend) {
    marketTrend = idea.aiAnalysis.marketTrend;
  } else if (forecast.trendVelocityPct > 10) {
    marketTrend = 'Upward';
  } else if (forecast.trendVelocityPct < -10) {
    marketTrend = 'Declining';
  } else {
    marketTrend = 'Stable';
  }

  const localSummary = localSummarize(ideaText, 4);

  return {
    successProbability: success,
    fundingReadiness,
    capitalEfficiencyScore: capEff,
    naiveBayesSentiment: nb,
    sentimentLabel: nb.label.charAt(0).toUpperCase() + nb.label.slice(1),
    feasibilityHeuristic: feas,
    hype,
    impact,
    contentDepth,
    authenticity,
    marketMaturity: CATEGORY_MARKET_MATURITY[idea.category] || 'Emerging',
    marketTrend,
    localStrategicSummary: localSummary,
    lexicalSentimentNote: 'Lexicon-weighted counts approximate multinomial Naive Bayes class posteriors.',
    engagementForecast: forecast,
    trendVelocityPct: forecast.trendVelocityPct,
    vcPipelineInterest: invC,
    categoryUniqueness: uniq,
    swotAvailable: !!swot,
    hotRankScore: Math.round(
      (idea.views || 0) * 0.6 +
      (idea.likes || []).length * 15 +
      (idea.comments || []).length * 22 +
      success * 0.5 +
      invC * 30 +
      hype.score * 0.2
    ),
  };
}

function attachMlPacksToIdeas(ideas, investmentCountByIdeaId) {
  const invMap = investmentCountByIdeaId || {};
  const published = ideas.filter((i) => i.status === 'Published');
  return ideas.map((doc) => {
    const d = { ...doc };
    const invC = invMap[String(d._id)] || 0;
    d.mlPack = buildMlPack(d, { investmentCount: invC, publishedPeers: published });
    return d;
  });
}

/**
 * Deterministic VC matchmaking — Cosine Similarity (TF-IDF approx).
 * No API calls. Returns a 0-99 score for how well an investor fits an idea.
 */
function calculateInvestorMatch(idea, investor) {
  if (!idea || !investor) return 0;
  const ideaTf = {};
  addTokensToTf(ideaTf, (idea.tags || []).join(' '));
  addTokensToTf(ideaTf, idea.category || '');
  addTokensToTf(ideaTf, idea.title || '');
  addTokensToTf(ideaTf, idea.summary || '');
  addTokensToTf(ideaTf, idea.problem || '');

  const invTf = {};
  addTokensToTf(invTf, (investor.focus || []).join(' '));
  addTokensToTf(invTf, investor.firm || '');
  addTokensToTf(invTf, investor.thesis || '');
  addTokensToTf(invTf, investor.description || '');
  addTokensToTf(invTf, (investor.portfolio || []).join(' '));

  const baseSim = cosineTf(ideaTf, invTf);

  // Category affinity boost: +15% if investor explicitly focuses on the same category
  let boost = 0;
  if (idea.category && Array.isArray(investor.focus)) {
    if (investor.focus.some(f => String(f).toLowerCase().includes(String(idea.category).toLowerCase()))) {
      boost = 0.15;
    }
  }

  // Stage preference boost
  const ideaStage = (idea.aiAnalysis && idea.aiAnalysis.stage) || (idea.mlPack && idea.mlPack.stage) || 'Seed';
  if (Array.isArray(investor.stagePreference) && investor.stagePreference.some(s => String(s).toLowerCase() === String(ideaStage).toLowerCase())) {
    boost += 0.05;
  }

  const finalScore = Math.min(99, Math.round((baseSim + boost) * 100));
  return Math.max(15, finalScore);
}

module.exports = {
  buildMlPack,
  attachMlPacksToIdeas,
  calculateInvestorMatch,
  tokenize,
  termFreq,
  cosineTf,
  jaccardSimilarity,
  localSummarize,
  feasibilityHeuristic,
};
