/**
 * IdeaVault — Express API
 * MongoDB + Mongoose + Auth (register, login, magic link)
 */

require('dotenv').config();

// If a Google API key was pasted into ANTHROPIC_API_KEY by mistake, use it for Gemini.
(function normalizeAiEnv() {
  const anth = process.env.ANTHROPIC_API_KEY && String(process.env.ANTHROPIC_API_KEY).trim();
  const gem = process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim();
  if (!gem && anth && anth.startsWith('AIza')) {
    process.env.GEMINI_API_KEY = anth;
    console.warn(
      '[IdeaVault] ANTHROPIC_API_KEY looks like a Google (Gemini) key. Using it as GEMINI_API_KEY. Fix .env: set GEMINI_API_KEY=... and remove the misplaced ANTHROPIC_API_KEY line.',
    );
  }
})();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const Razorpay = require('razorpay');
const aiService = require('./services/aiService');
const { groqApiKeyList } = require('./utils/groqKeys');

const JWT_SECRET = process.env.JWT_SECRET || 'ideavault_secret_2026';

const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI =
  process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/IDEAVAULT';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_fake_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'rzp_test_fake_secret',
});

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));

// AI Usage Limiter Middleware
async function aiUsageMiddleware(req, res, next) {
  try {
    const userId = getBearerUserId(req);
    if (!userId) return next(); // Skip for public calls or handle separately if needed

    const today = new Date().toISOString().slice(0, 10);
    let usage = await ApiUsage.findOne({ userId });
    
    if (!usage) {
      usage = new ApiUsage({ userId, lastResetDate: today });
    }

    if (usage.lastResetDate !== today) {
      usage.requestsToday = 0;
      usage.lastResetDate = today;
    }

    const limit = Number(process.env.AI_DAILY_LIMIT) || 50;
    if (usage.requestsToday >= limit) {
      return res.status(429).json({ error: 'Daily AI limit reached. Upgrade to premium for more.' });
    }

    usage.requestsToday += 1;
    usage.totalRequests += 1;
    await usage.save();
    next();
  } catch (e) {
    next(); // Don't block on usage tracking errors
  }
}

// ---------------------------------------------------------------------------
// AI: Google Gemini (primary) + Anthropic Claude (optional fallback)
// Set GEMINI_API_KEY + GEMINI_MODEL (e.g. gemini-2.0-flash). gemini-1.5-flash-8b is often 404 on v1beta — use fallbacks.
// ---------------------------------------------------------------------------
const { GoogleGenerativeAI } = require('@google/generative-ai');

const USD_TO_INR = Math.max(1, Number(process.env.USD_TO_INR) || 83);

function geminiModelCandidates() {
  const primary = (process.env.GEMINI_MODEL && String(process.env.GEMINI_MODEL).trim()) || 'gemini-2.0-flash';
  const fromEnv = process.env.GEMINI_MODEL_FALLBACKS
    ? String(process.env.GEMINI_MODEL_FALLBACKS)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const defaults = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
  const out = [];
  const seen = new Set();
  for (const m of [primary, ...fromEnv, ...defaults]) {
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

function getActiveGeminiKey() {
  const g = process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim();
  if (g) return g;
  const a = process.env.ANTHROPIC_API_KEY && String(process.env.ANTHROPIC_API_KEY).trim();
  if (a && a.startsWith('AIza')) return a;
  return null;
}

async function callGemini(prompt, maxTokens = 800, opts = {}) {
  const key = getActiveGeminiKey();
  if (!key) throw new Error('GEMINI_API_KEY is not set (Google AI Studio key, usually starts with AIza)');
  const genAI = new GoogleGenerativeAI(key);
  const models = geminiModelCandidates();
  let lastErr = null;
  const generationBase = {
    maxOutputTokens: maxTokens,
    temperature: opts.temperature != null ? opts.temperature : 0.35,
  };
  if (opts.jsonMode) {
    generationBase.responseMimeType = 'application/json';
  }
  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: generationBase,
      });
      const result = await model.generateContent(String(prompt));
      const text = result.response?.text?.();
      if (!text) throw new Error('Empty Gemini response');
      if (modelName !== models[0]) {
        console.warn('[IdeaVault] Gemini: primary model failed; succeeded with', modelName);
      }
      return text;
    } catch (e) {
      lastErr = e;
      console.warn('[IdeaVault] Gemini model failed:', modelName, String(e && e.message ? e.message : e));
    }
  }
  const hint =
    'Check GEMINI_MODEL in backend/.env (try gemini-2.0-flash or gemini-1.5-flash). See https://ai.google.dev/gemini-api/docs/models';
  throw new Error(
    lastErr ? `Gemini error after trying models [${models.join(', ')}]: ${lastErr.message || lastErr}. ${hint}` : `Gemini failed. ${hint}`,
  );
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGroq(prompt, maxTokens = 1000, opts = {}) {
  const keys = groqApiKeyList();
  if (!keys.length) throw new Error('GROQ_API_KEY is not set (or use GROQ_API_KEY_2 / comma-separated keys)');
  const groqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  let lastErr = null;
  for (const key of keys) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: groqModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: opts.temperature != null ? opts.temperature : 0.35,
          ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        const err = data.error?.message || JSON.stringify(data);
        const msg = String(err);
        lastErr = new Error(`Groq API error: ${msg}`);
        const retryable =
          response.status === 429 ||
          response.status === 401 ||
          /rate|quota|limit|invalid.*key|unauthor/i.test(msg);
        if (retryable && keys.length > 1) continue;
        throw lastErr;
      }
      return data.choices[0].message.content;
    } catch (e) {
      lastErr = e;
      if (keys.length > 1 && String(e.message || e).match(/429|401|rate|quota|key/i)) continue;
      throw e;
    }
  }
  throw lastErr || new Error('Groq: all keys failed');
}

async function callOpenRouter(prompt, maxTokens = 1000, opts = {}) {
  const key = process.env.OPENROUTER_API_KEY && String(process.env.OPENROUTER_API_KEY).trim();
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openrouter/free',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const err = data.error?.message || JSON.stringify(data);
    throw new Error(`OpenRouter API error: ${err}`);
  }
  return data.choices[0].message.content;
}

let rpmCount = 0;
let rpmStart = Date.now();
async function rateLimit() {
  const rpmLimit = Number(process.env.AI_RATE_LIMIT_RPM) || 10;
  if (Date.now() - rpmStart > 60000) {
    rpmCount = 0;
    rpmStart = Date.now();
  }
  if (rpmCount >= rpmLimit) {
    const waitTime = 60000 - (Date.now() - rpmStart) + Math.random() * 1000;
    console.log(`[IdeaVault] Rate limit reached. Waiting ${Math.round(waitTime/1000)}s...`);
    await wait(waitTime);
    rpmCount = 0;
    rpmStart = Date.now();
  }
  rpmCount++;
}

async function callAiProviderChain(prompt, maxTokens = 800, opts = {}) {
  await rateLimit();
  const orderStr = process.env.AI_PROVIDER_ORDER || 'gemini,groq,openrouter';
  const order = orderStr.split(',').map(s => s.trim().toLowerCase());
  
  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    try {
      if (provider === 'gemini') {
        return await callGemini(prompt, maxTokens, opts);
      } else if (provider === 'groq') {
        return await callGroq(prompt, maxTokens, opts);
      } else if (provider === 'openrouter') {
        return await callOpenRouter(prompt, maxTokens, opts);
      }
    } catch (e) {
      console.warn(`[IdeaVault] Provider ${provider} failed: ${e.message || e}`);
      lastErr = e;
      if (e.message && (e.message.includes('429') || e.message.includes('quota') || e.message.includes('Too Many Requests'))) {
        const baseWait = Math.pow(2, i) * 2000;
        const jitter = Math.random() * 1000;
        const totalWait = baseWait + jitter;
        console.warn(`[IdeaVault] 429 detected on ${provider}, waiting ${Math.round(totalWait)}ms before next provider...`);
        await wait(totalWait);
      }
    }
  }
  
  throw new Error(`All configured AI providers failed. Last error: ${lastErr ? lastErr.message : 'Unknown'}`);
}

async function callAiTextForJson(prompt, maxTokens = 1200) {
  try {
    return await callAiProviderChain(prompt, maxTokens, { jsonMode: true, temperature: 0.25 });
  } catch (e) {
    console.warn('[IdeaVault] JSON mode failed, retrying plain:', e.message || e);
    return callAiProviderChain(prompt, maxTokens, { temperature: 0.25 });
  }
}

async function callAiText(prompt, maxTokens = 800) {
  return callAiProviderChain(prompt, maxTokens);
}

app.get('/api/config', (req, res) => {
  res.json({
    usdToInr: USD_TO_INR,
    geminiPrimary: geminiModelCandidates()[0],
    geminiFallbacks: geminiModelCandidates(),
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_fake_id',
  });
});

// ---------------------------------------------------------------------------
// Nodemailer (Gmail SSL 465)
// ---------------------------------------------------------------------------
function createMailer() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

function appBaseUrl(req) {
  const host = req.get('host') || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${host}`;
}

async function sendHtmlEmail(to, subject, html) {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) {
    console.warn('[IdeaVault] EMAIL_USER / EMAIL_PASS not set — skipping send to', to);
    return;
  }
  const transporter = createMailer();
  await transporter.sendMail({
    from: `"IdeaVault" <${user}>`,
    to,
    subject,
    html,
  });
}

function verificationEmailHtml(verifyUrl, name) {
  return `
  <!DOCTYPE html>
  <html><head><meta charset="utf-8"><title>Verify IdeaVault</title></head>
  <body style="margin:0;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F8FAFC;color:#0F172A;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:32px 16px;">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="background:#FFFFFF;border-radius:16px;border:1px solid #E2E8F0;box-shadow:0 2px 10px rgba(0,0,0,0.05);overflow:hidden;">
          <tr><td style="padding:32px 28px 8px;">
            <div style="font-size:22px;font-weight:700;background:linear-gradient(90deg,#6366F1,#3B82F6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">IdeaVault</div>
            <p style="margin:16px 0 0;font-size:15px;line-height:1.6;">Hi ${name || 'there'},</p>
            <p style="margin:12px 0 0;font-size:15px;line-height:1.6;">Welcome! Confirm your email to activate your account and start turning ideas into impact.</p>
          </td></tr>
          <tr><td style="padding:8px 28px 32px;">
            <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(90deg,#6366F1,#3B82F6);color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px;">Verify my email</a>
            <p style="margin:20px 0 0;font-size:12px;color:#64748B;">This link expires in 15 minutes. If you did not sign up, you can ignore this message.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

function magicLoginEmailHtml(verifyUrl, name) {
  return `
  <!DOCTYPE html>
  <html><head><meta charset="utf-8"><title>Sign in to IdeaVault</title></head>
  <body style="margin:0;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F8FAFC;color:#0F172A;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:32px 16px;">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="background:#FFFFFF;border-radius:16px;border:1px solid #E2E8F0;box-shadow:0 2px 10px rgba(0,0,0,0.05);">
          <tr><td style="padding:32px 28px 8px;">
            <div style="font-size:22px;font-weight:700;background:linear-gradient(90deg,#6366F1,#3B82F6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">IdeaVault</div>
            <p style="margin:16px 0 0;font-size:15px;">Hi ${name || 'there'},</p>
            <p style="margin:12px 0 0;font-size:15px;line-height:1.6;">Click the button below to sign in securely. No password required for this session.</p>
          </td></tr>
          <tr><td style="padding:8px 28px 32px;">
            <a href="${verifyUrl}" style="display:inline-block;background:#6366F1;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:600;">Sign in with magic link</a>
            <p style="margin:20px 0 0;font-size:12px;color:#64748B;">Expires in 15 minutes.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

// ---------------------------------------------------------------------------
// Mongoose schemas
// ---------------------------------------------------------------------------
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  phone: { type: String, default: '' },
  dob: { type: Date, default: null },
  occupation: { type: String, default: '' },
  address: { type: String, default: '' },
  bio: { type: String, default: '' },
  image: { type: String, default: '' },
  experience: { type: String, default: '' },
  isVerified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const magicLinkSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  token: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
magicLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ideaSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, default: '' },
  email: { type: String, default: '' },
  role: { type: String, default: '' },
  experience: { type: String, default: '' },
  title: { type: String, required: true },
  category: { type: String, default: '' },
  tags: [{ type: String }],
  idealCustomer: { type: String, default: '' },
  problem: { type: String, default: '' },
  solution: { type: String, default: '' },
  summary: { type: String, default: '' },
  aiSummary: { type: String, default: '' },
  aiAnalysis: { type: mongoose.Schema.Types.Mixed, default: null },
  aiRoadmap: { type: mongoose.Schema.Types.Mixed, default: null },
  aiSentiment: { type: mongoose.Schema.Types.Mixed, default: null },
  aiCache: {
    contentHash: { type: String, default: '' },
    summaryHash: { type: String, default: '' },
    analysisHash: { type: String, default: '' },
    roadmapHash: { type: String, default: '' },
    sentimentHash: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now },
  },
  link: { type: String, default: '' },
  image: { type: String, default: '' },
  status: { type: String, enum: ['Draft', 'Published'], default: 'Draft' },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      user: { type: String, default: '' },
      text: { type: String, required: true },
      timestamp: { type: Date, default: Date.now },
    },
  ],
  views: { type: Number, default: 0 },
  viewsHistory: [{ date: { type: Date }, count: { type: Number } }],
  reads: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      duration: { type: Number, default: 0 },
      timestamp: { type: Date, default: Date.now },
    },
  ],
  ratings: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      score: { type: Number, min: 1, max: 5 },
    },
  ],
  feedback: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      userName: { type: String, default: '' },
      text: { type: String, default: '' },
      rating: { type: Number, default: 0 },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  fundraising: {
    goalUsd: { type: Number, default: 0 },
    raisedUsd: { type: Number, default: 0 },
    minInvestmentUsd: { type: Number, default: 0 },
    equityOffered: { type: Number, default: 0 },
    valuationUsd: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    updatedAt: { type: Date, default: Date.now },
  },
  /** When true, idea is hidden from public “trending / Get Inspired” and listed on VC desk after fundraising or investor interest. */
  vcTrack: { type: Boolean, default: false },
  vcTrackSince: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

const investorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  firm: { type: String, default: '' },
  focus: [{ type: String }],
  stagePreference: [{ type: String }],
  ticketSize: { type: String, default: '' },
  email: { type: String, default: '' },
  website: { type: String, default: '' },
  portfolio: [{ type: String }],
  description: { type: String, default: '' },
  thesis: { type: String, default: '' },
  sweetSpot: { type: String, default: '' },
  process: { type: String, default: '' },
  location: { type: String, default: '' },
  photo: { type: String, default: '' },
  phone: { type: String, default: '' },
});

const blogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  author: { type: String, default: '' },
  authorImg: { type: String, default: '' },
  title: { type: String, required: true },
  summary: { type: String, default: '' },
  content: { type: String, default: '' },
  category: { type: String, default: '' },
  image: { type: String, default: '' },
  readTime: { type: String, default: '' },
  featured: { type: Boolean, default: false },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now },
});

const blogReviewSchema = new mongoose.Schema({
  blogId: { type: mongoose.Schema.Types.ObjectId, ref: 'Blog', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, default: '' },
  rating: { type: Number, min: 1, max: 5, required: true },
  text: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

// Generic cache for expensive AI calls not stored on an Idea (e.g. generator, VC match)
const aiCacheSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
aiCacheSchema.index({ updatedAt: 1 });

const investmentSchema = new mongoose.Schema({
  investorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ideaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Idea', required: true },
  amountUsd: { type: Number, default: 0 },
  equityPct: { type: Number, default: 0 },
  valuationUsd: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['Interested', 'Reviewing', 'PitchScheduled', 'DueDiligence', 'Negotiation', 'Committed', 'Funded', 'Invested', 'Rejected', 'Bookmarked'],
    default: 'Interested',
  },
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
investmentSchema.index({ investorUserId: 1, ideaId: 1 }, { unique: true });

const fundingRoundSchema = new mongoose.Schema({
  ideaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Idea', required: true },
  founderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetAmountUsd: { type: Number, default: 0 },
  minInvestmentUsd: { type: Number, default: 0 },
  equityOffered: { type: Number, default: 0 },
  valuationUsd: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ideaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Idea' },
  amountUsd: { type: Number, required: true },
  amountInr: { type: Number },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  status: { type: String, enum: ['Pending', 'Success', 'Failed'], default: 'Pending' },
  createdAt: { type: Date, default: Date.now },
});

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, default: 'vc' },
  text: { type: String, default: '' },
  read: { type: Boolean, default: false },
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now },
});
notificationSchema.index({ userId: 1, createdAt: -1 });

const apiUsageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  totalRequests: { type: Number, default: 0 },
  failedRequests: { type: Number, default: 0 },
  avgResponseTime: { type: Number, default: 0 },
  quotaErrors: { type: Number, default: 0 },
  requestsToday: { type: Number, default: 0 },
  lastResetDate: { type: String, default: () => new Date().toISOString().slice(0, 10) }
});

const User = mongoose.model('User', userSchema);
const MagicLink = mongoose.model('MagicLink', magicLinkSchema);
const Idea = mongoose.model('Idea', ideaSchema);
const Investor = mongoose.model('Investor', investorSchema);
const Blog = mongoose.model('Blog', blogSchema);
const BlogReview = mongoose.model('BlogReview', blogReviewSchema);
const AICache = mongoose.model('AICache', aiCacheSchema);
const Investment = mongoose.model('Investment', investmentSchema);
const FundingRound = mongoose.model('FundingRound', fundingRoundSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const ApiUsage = mongoose.model('ApiUsage', apiUsageSchema);

async function markIdeaVcTrack(ideaId) {
  if (!mongoose.isValidObjectId(ideaId)) return;
  await Idea.updateOne(
    { _id: ideaId },
    { $set: { vcTrack: true, vcTrackSince: new Date() } },
  );
}

module.exports = {
  User, MagicLink, Idea, Investor, Blog, BlogReview, AICache, Investment, FundingRound, Transaction, Notification, ApiUsage
};

const { attachMlPacksToIdeas, buildMlPack, localSummarize, calculateInvestorMatch } = require('./ml/pack');

/** Live UI refresh (Socket.io). */
let ioInstance = null;
function emitIdeaVaultLive(ideaId) {
  try {
    if (ioInstance) {
      ioInstance.emit('iv:refresh', { ideaId: ideaId ? String(ideaId) : '', ts: Date.now() });
    }
  } catch (e) {
    /* ignore */
  }
}

/** Emit targeted stats for a single idea — updates all IdeaCards in-place on every client. */
async function emitIdeaStats(ideaId) {
  try {
    if (!ioInstance) return;
    const idea = await Idea.findById(ideaId).select('views likes comments').lean();
    if (!idea) return;
    ioInstance.emit('iv:idea:stats', {
      ideaId: String(ideaId),
      views: idea.views || 0,
      likes: (idea.likes || []).length,
      comments: (idea.comments || []).length,
      ts: Date.now(),
    });
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sanitizeUser(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : { ...doc };
  delete o.password;
  return o;
}

function issueToken(user) {
  return jwt.sign({ sub: String(user._id), email: user.email }, JWT_SECRET, { expiresIn: '14d' });
}

function compositeScore(idea) {
  const likes = (idea.likes && idea.likes.length) || 0;
  const comments = (idea.comments && idea.comments.length) || 0;
  const views = idea.views || 0;
  let avgRating = 0;
  if (idea.ratings && idea.ratings.length) {
    avgRating =
      idea.ratings.reduce((s, r) => s + (Number(r.score) || 0), 0) / idea.ratings.length;
  }
  const innov =
    idea.aiAnalysis && typeof idea.aiAnalysis.innovationScore === 'number'
      ? idea.aiAnalysis.innovationScore
      : 5;
  return likes * 10 + comments * 15 + views * 0.5 + avgRating * 25 + innov * 5;
}

function stableStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, function (k, v) {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      if (Array.isArray(v)) return v;
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = v[key];
      return out;
    }
    return v;
  });
}

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function ideaContentInput(ideaLike) {
  const tags = Array.isArray(ideaLike.tags)
    ? ideaLike.tags
    : typeof ideaLike.tags === 'string'
      ? ideaLike.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
  return {
    title: ideaLike.title || '',
    category: ideaLike.category || '',
    tags,
    idealCustomer: ideaLike.idealCustomer || '',
    problem: ideaLike.problem || '',
    solution: ideaLike.solution || '',
    summary: ideaLike.summary || '',
    link: ideaLike.link || '',
    status: ideaLike.status || '',
    role: ideaLike.role || '',
    experience: ideaLike.experience || '',
  };
}

function computeIdeaContentHash(ideaLike) {
  return sha256(stableStringify(ideaContentInput(ideaLike)));
}

function aiKey(kind, contentHash) {
  return sha256(`${kind}:${contentHash}`);
}

/** Strip ```json fences and leading/trailing prose. */
function stripAiMarkdownFences(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```(?:json|JSON)?\s*/i, '');
  t = t.replace(/\s*```\s*$/i, '');
  return t.trim();
}

function fixTrailingCommasInJson(s) {
  return String(s).replace(/,\s*([}\]])/g, '$1');
}

/**
 * Extract first balanced `{ ... }` honoring JSON strings (double-quoted only).
 * Safer than first `{` to last `}` when `}` appears inside strings.
 */
function extractBalancedJsonObject(s) {
  const str = String(s || '');
  const start = str.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseJsonString(slice) {
  if (!slice) return null;
  const candidates = [slice, fixTrailingCommasInJson(slice)];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (e) {
      /* continue */
    }
  }
  return null;
}

/** Parse model output into an object (Gemini often wraps in fences or adds trailing text). */
function parseAiJson(text) {
  const cleaned = stripAiMarkdownFences(text);
  const balanced = extractBalancedJsonObject(cleaned);
  const attempts = [cleaned, balanced, balanced ? fixTrailingCommasInJson(balanced) : null].filter(Boolean);
  for (const a of attempts) {
    const j = tryParseJsonString(a);
    if (j && typeof j === 'object') return j;
  }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const legacy = fixTrailingCommasInJson(cleaned.slice(first, last + 1));
    const j = tryParseJsonString(legacy);
    if (j && typeof j === 'object') return j;
  }
  return null;
}

async function repairJsonWithAi(badFragment, hint) {
  const clip = String(badFragment || '').slice(0, 12000);
  const prompt = `You fix malformed JSON from another LLM.\nTask: ${hint}\nRules: Output ONLY one valid JSON object. No markdown, no code fences, no explanation before or after.\nIf data was truncated, invent plausible values for missing fields so the JSON is complete.\n\nBroken or partial input:\n${clip}`;
  const t2 = await callAiText(prompt, 2800);
  return parseAiJson(t2);
}

async function parseAiJsonWithRepair(text, repairHint) {
  let json = parseAiJson(text);
  if (json) return json;
  try {
    json = await repairJsonWithAi(text, repairHint);
  } catch (e) {
    console.warn('[IdeaVault] JSON repair failed:', e.message || e);
  }
  return json;
}

/** @deprecated use parseAiJson */
function extractJson(text) {
  return parseAiJson(text);
}

function getBearerUserId(req) {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const payload = jwt.verify(m[1], JWT_SECRET);
    return String(payload.sub || '');
  } catch (e) {
    return null;
  }
}

/** Published ideas: anyone can trigger AI (community). Drafts: founder only (JWT). */
function canRunAiOnIdea(req, idea) {
  if (!idea) return false;
  if (idea.status === 'Published') return true;
  const uid = getBearerUserId(req);
  return Boolean(uid && String(idea.userId) === uid);
}

function clampNum(n, lo, hi, fallback) {
  const v = Number(n);
  if (Number.isNaN(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/** Deterministic charts + engagement math from stored idea + AI scores (saves API calls). */
function enrichAnalysisWithMl(idea, json) {
  if (!json || typeof json !== 'object') return json;
  const likes = (idea.likes && idea.likes.length) || 0;
  const comments = (idea.comments && idea.comments.length) || 0;
  const views = Math.max(0, idea.views || 0);
  const engagementRate = views > 0 ? Math.min(100, ((likes + comments * 2) / views) * 100) : 0;

  const innov = clampNum(json.innovationScore, 1, 10, 5);
  const feas = clampNum(json.feasibilityScore, 1, 10, 5);
  const risk = clampNum(json.riskScore, 1, 10, 5);
  const vcFit = clampNum(json.vcFitScore, 0, 100, 50);
  const health = clampNum(json.startupHealthScore, 0, 100, Math.round((innov + feas) * 5));

  const totalEng = Math.max(1, likes + comments + Math.max(1, Math.round(views / 25)));
  const pLikes = (likes / totalEng) * 100;
  const pComm = (comments / totalEng) * 100;
  const pView = Math.max(0, 100 - pLikes - pComm);
  const pieCommunity = [
    {
      label: 'Likes',
      pct: Math.round(pLikes * 10) / 10,
      fact: `${likes} users liked this idea (stored in MongoDB).`,
    },
    {
      label: 'Comments',
      pct: Math.round(pComm * 10) / 10,
      fact: `${comments} discussion threads — qualitative signal for product-market curiosity.`,
    },
    {
      label: 'Passive views',
      pct: Math.round(pView * 10) / 10,
      fact: `${views} total views; lurkers often indicate awareness before engagement.`,
    },
  ];

  json.mlCharts = {
    scoreBars: [
      {
        label: 'Innovation',
        pct: innov * 10,
        fact: `Model scored innovation ${innov}/10 from problem–solution fit and differentiation cues.`,
      },
      {
        label: 'Feasibility',
        pct: feas * 10,
        fact: `Feasibility ${feas}/10 reflects delivery realism vs. scope in your description.`,
      },
      {
        label: 'Risk (inverse)',
        pct: Math.max(0, 100 - risk * 10),
        fact: `Risk index ${risk}/10 — higher means more execution/regulatory/market risk to monitor.`,
      },
      {
        label: 'VC thesis fit',
        pct: vcFit,
        fact: `VC fit ${vcFit}/100 vs. typical early-stage investor theses in comparable categories.`,
      },
      {
        label: 'Startup health',
        pct: health,
        fact: `Composite health ${health}/100 blends model scores with traction proxies.`,
      },
      {
        label: 'Engagement intensity',
        pct: Math.round(engagementRate * 10) / 10,
        fact: `Engagement rate ${Math.round(engagementRate * 10) / 10}% = (likes + 2×comments) / views on this card.`,
      },
    ],
    pieCommunity,
    engagementRate: Math.round(engagementRate * 10) / 10,
  };

  if (!json.strategicNarrative || typeof json.strategicNarrative !== 'object') {
    const mk = Array.isArray(json.targetMarkets) ? json.targetMarkets.slice(0, 2).join(', ') : '';
    json.strategicNarrative = {
      who: mk
        ? `Likely early adopters cluster around ${mk}, aligned with “${idea.idealCustomer || 'your stated customer'}”.`
        : `Stakeholders include ${idea.idealCustomer || 'buyers and operators'} implied by your pitch.`,
      what: json.marketSummary
        ? String(json.marketSummary).slice(0, 420)
        : `You are positioning a ${idea.category || 'startup'} solution to: ${(idea.problem || '').slice(0, 200)}`,
      why: json.thesis
        ? String(json.thesis).slice(0, 400)
        : 'The model infers demand from category maturity, problem clarity, and solution specificity.',
      how: json.explanation
        ? String(json.explanation).slice(0, 450)
        : 'Execution path should validate assumptions with pilots, measure retention, then scale distribution.',
      prevention: Array.isArray(json.topRisks) && json.topRisks.length
        ? json.topRisks
            .slice(0, 3)
            .map((r) => `${r.risk || 'Risk'} → mitigate by ${r.mitigation || 'testing and iteration'}`)
            .join(' ')
        : 'Pre-empt failure by tracking runway, compliance in regulated categories, and competitor moves.',
    };
  }

  return json;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ');
}

/** Rule-based VC match — no per-investor LLM calls (quota-friendly). */
function computeVcRuleMatches(idea, investors) {
  const ideaBlob = norm(`${idea.title} ${idea.category} ${idea.problem} ${idea.solution} ${(idea.tags || []).join(' ')}`);
  const innov = idea.aiAnalysis && typeof idea.aiAnalysis.innovationScore === 'number' ? idea.aiAnalysis.innovationScore : 5;
  const likes = (idea.likes && idea.likes.length) || 0;
  const comments = (idea.comments && idea.comments.length) || 0;
  const views = idea.views || 0;
  const engagementSignal = views > 0 ? Math.min(15, Math.round(((likes + comments * 2) / views) * 100)) : 0;

  const out = [];
  for (const inv of investors) {
    let score = 0;
    const highlights = [];

    for (const f of inv.focus || []) {
      const fk = norm(f);
      if (!fk.trim()) continue;
      const tokens = fk.split(/\s+/).filter((t) => t.length > 1);
      let hit = false;
      for (const t of tokens) {
        if (ideaBlob.includes(t)) {
          hit = true;
          break;
        }
      }
      if (hit || ideaBlob.includes(fk.replace(/\s+/g, ''))) {
        score += 38;
        highlights.push(`Sector focus: ${f}`);
        break;
      }
    }

    const cat = norm(idea.category);
    for (const f of inv.focus || []) {
      if (cat && norm(f).split(/\s+/).some((w) => w.length > 2 && cat.includes(w))) {
        score += 22;
        highlights.push(`Category aligns with ${f}`);
        break;
      }
    }

    if ((inv.stagePreference || []).some((st) => ideaBlob.includes(norm(st).split(' ')[0]))) {
      score += 18;
      highlights.push('Stage language matches your idea maturity cues');
    } else {
      score += 8;
    }

    if (innov >= 8) {
      score += 16;
      highlights.push('Strong innovation score from AI analysis');
    } else if (innov >= 6) {
      score += 8;
    }

    score += Math.min(12, engagementSignal);

    const completeness = [idea.title, idea.problem, idea.solution, idea.idealCustomer].filter(Boolean).length;
    score += completeness * 3;

    score = Math.min(100, Math.round(score));
    const reason =
      highlights.length > 0
        ? highlights.slice(0, 4).join(' · ')
        : `${inv.firm || inv.name} is a general fit — refine your category/tags for sharper alignment.`;

    out.push({
      investorId: String(inv._id),
      investor: inv,
      score,
      reason,
      fitHighlights: highlights,
    });
  }
  out.sort((a, b) => (b.score || 0) - (a.score || 0));
  return out.slice(0, 8);
}

function escHtmlDoc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sumLast7dViews(idea) {
  let sum = 0;
  for (let d = 6; d >= 0; d -= 1) {
    const dt = new Date();
    dt.setUTCDate(dt.getUTCDate() - d);
    dt.setUTCHours(0, 0, 0, 0);
    const key = dt.toISOString().slice(0, 10);
    for (const h of idea.viewsHistory || []) {
      if (new Date(h.date).toISOString().slice(0, 10) === key) sum += h.count || 0;
    }
  }
  return sum;
}

function buildCreatorPackHtml(idea, founderName) {
  const a = idea.aiAnalysis || {};
  const r = idea.aiRoadmap || {};
  const sw = a.swot || {};
  const phases = (r.phases || [])
    .map(
      (p) =>
        `<section class="blk"><h3>${escHtmlDoc(p.name)}</h3><p><strong>Timeline / budget:</strong> ${escHtmlDoc(p.duration)} · ${escHtmlDoc(p.budget || '')}</p><p><strong>Milestone:</strong> ${escHtmlDoc(p.milestone || '')}</p><ul>${(p.tasks || []).map((t) => `<li>${escHtmlDoc(t)}</li>`).join('')}</ul></section>`,
    )
    .join('');
  const roadExtra = `<p><strong>First step:</strong> ${escHtmlDoc(r.firstStep || '')}</p><p><strong>Market entry:</strong> ${escHtmlDoc(r.marketEntry || '')}</p><p><strong>Risk mitigation:</strong> ${escHtmlDoc(r.riskMitigation || '')}</p>`;
  const swotHtml = `<div class="grid2"><div><h4>Strengths</h4><ul>${(sw.strengths || []).map((x) => `<li>${escHtmlDoc(x)}</li>`).join('')}</ul></div><div><h4>Weaknesses</h4><ul>${(sw.weaknesses || []).map((x) => `<li>${escHtmlDoc(x)}</li>`).join('')}</ul></div><div><h4>Opportunities</h4><ul>${(sw.opportunities || []).map((x) => `<li>${escHtmlDoc(x)}</li>`).join('')}</ul></div><div><h4>Threats</h4><ul>${(sw.threats || []).map((x) => `<li>${escHtmlDoc(x)}</li>`).join('')}</ul></div></div>`;
  const risks = (a.topRisks || [])
    .map((x) => `<li><strong>${escHtmlDoc(x.risk)}</strong> — Mitigation: ${escHtmlDoc(x.mitigation || '')}</li>`)
    .join('');
  const narr = a.strategicNarrative || {};
  const fund = idea.fundraising || {};
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Creator pack — ${escHtmlDoc(idea.title)}</title><style>body{font-family:Outfit,Segoe UI,sans-serif;max-width:880px;margin:40px auto;padding:0 24px;color:#0f172a;line-height:1.55}h1{font-size:1.6rem}h2{margin-top:28px;border-bottom:2px solid #e2e8f0;padding-bottom:6px}.blk{margin:16px 0;padding:16px;border:1px solid #e2e8f0;border-radius:12px}.callout{background:linear-gradient(120deg,#eef2ff,#dbeafe);padding:16px;border-radius:12px;margin:16px 0}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media print{body{margin:16px}}</style></head><body>
  <h1>${escHtmlDoc(idea.title)}</h1><p><strong>Founder:</strong> ${escHtmlDoc(founderName)} · <strong>Category:</strong> ${escHtmlDoc(idea.category || '')}</p>
  <div class="callout"><h2>Executive AI summary</h2><p>${escHtmlDoc(idea.aiSummary || idea.summary || '')}</p></div>
  <h2>Problem &amp; solution (your pitch core)</h2><p><strong>Problem</strong></p><p>${escHtmlDoc(idea.problem || '')}</p><p><strong>Solution</strong></p><p>${escHtmlDoc(idea.solution || '')}</p>
  <h2>Strategic narrative</h2><p><strong>Who:</strong> ${escHtmlDoc(narr.who || '')}</p><p><strong>What:</strong> ${escHtmlDoc(narr.what || '')}</p><p><strong>Why:</strong> ${escHtmlDoc(narr.why || '')}</p><p><strong>How:</strong> ${escHtmlDoc(narr.how || '')}</p><p><strong>Prevention:</strong> ${escHtmlDoc(narr.prevention || '')}</p>
  <h2>Market &amp; scores (AI + stored metrics)</h2><p>${escHtmlDoc(a.marketSummary || '')}</p><p>Maturity: ${escHtmlDoc(a.maturity || '')} · Market size cue: ${escHtmlDoc(a.marketSize || '')} · Growth: ${escHtmlDoc(a.growthRate || '')}</p>
  <p>Innovation ${escHtmlDoc(String(a.innovationScore ?? '—'))}/10 · Feasibility ${escHtmlDoc(String(a.feasibilityScore ?? '—'))}/10 · Risk ${escHtmlDoc(String(a.riskScore ?? '—'))}/10 · VC fit ${escHtmlDoc(String(a.vcFitScore ?? '—'))}/100</p>
  <p>${escHtmlDoc(a.explanation || '')}</p>
  <h2>SWOT</h2>${swotHtml}
  <h2>Risks &amp; how to prevent them</h2><ul>${risks || '<li>Generate AI analysis from Create Idea to populate structured risks.</li>'}</ul>
  <h2>Roadmap (private to you)</h2><p>Total timeline: ${escHtmlDoc(r.totalTimeline || '')} · Budget envelope: ${escHtmlDoc(r.totalBudget || '')}</p>${phases || '<p>Generate roadmap from Create Idea.</p>'}${roadExtra}
  <h2>Fundraising tracker</h2><p>Goal: ₹${escHtmlDoc(String(fund.targetAmount || fund.goalUsd || 0))} · Raised: ₹${escHtmlDoc(String(fund.raisedAmount || fund.raisedUsd || 0))}</p>
  <p style="color:#64748b;font-size:0.9rem;margin-top:40px">Confidential IdeaVault creator export — for your use only.</p>
  <script>window.onload = function() { window.print(); setTimeout(function(){ window.history.back(); }, 1000); }</script>
  </body></html>`;
}

function fallbackDashboardNarrative(stats) {
  if (!stats || typeof stats !== 'object') {
    return 'Connect traction data by publishing ideas and collecting views, likes, and comments. Run AI analysis on each idea for a tailored investor narrative.';
  }
  const s = stats;
  const parts = [
    `Your dashboard health is ${s.score}/100 (${s.label}).`,
    `Engagement rate across your ideas is ${s.eng || 0}% (likes + comments vs views).`,
    s.invHasAi
      ? `Innovation signals from AI average ${(s.invAvg || 0).toFixed(1)}/10 and VC thesis fit averages ${Math.round(s.vcAvg || 0)}/100.`
      : 'Run “AI analysis” on published ideas so scores reflect your actual narrative instead of engagement-only proxies.',
    s.pubCount
      ? `You have ${s.pubCount} published idea(s) — keep shipping weekly updates to lift reach.`
      : 'Publish at least one idea to unlock community feedback loops.',
  ];
  return parts.join(' ');
}

async function createMagicLinkToken(email) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await MagicLink.deleteMany({ email: email.toLowerCase().trim() });
  await MagicLink.create({ email: email.toLowerCase().trim(), token, expiresAt });
  return token;
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

/** POST /api/register */
app.post('/api/register', async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      dob,
      occupation,
      address,
      bio,
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }

    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({
      name: String(name).trim(),
      email: email.toLowerCase().trim(),
      password: hashed,
      phone: phone || '',
      dob: dob ? new Date(dob) : null,
      occupation: occupation || '',
      address: address || '',
      bio: bio || '',
      isVerified: false,
    });

    const token = await createMagicLinkToken(user.email);
    const verifyUrl = `${appBaseUrl(req)}/api/verify-magic-link?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;

    await sendHtmlEmail(
      user.email,
      'Verify your IdeaVault account',
      verificationEmailHtml(verifyUrl, user.name),
    );

    return res.status(201).json({
      message: 'Account created. Check your email to verify.',
      userId: user._id,
      email: user.email,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Registration failed.' });
  }
});

/** POST /api/login */
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        error: 'Please verify your email before logging in. Check your inbox for the magic link.',
        needsVerification: true,
        email: user.email,
      });
    }

    const token = issueToken(user);
    return res.json({ user: sanitizeUser(user), token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Login failed.' });
  }
});

/** POST /api/send-magic-link */
app.post('/api/send-magic-link', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Do not reveal whether email exists
      return res.json({ message: 'If an account exists for this email, you will receive a magic link shortly.' });
    }

    const token = await createMagicLinkToken(user.email);
    const verifyUrl = `${appBaseUrl(req)}/api/verify-magic-link?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;

    await sendHtmlEmail(
      user.email,
      'Your IdeaVault magic link',
      magicLoginEmailHtml(verifyUrl, user.name),
    );

    return res.json({ message: 'Check your email for a sign-in link.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Could not send magic link.' });
  }
});

/** GET /api/verify-magic-link?token=&email= */
app.get('/api/verify-magic-link', async (req, res) => {
  try {
    const { token: magicToken, email } = req.query;
    if (!magicToken || !email) {
      return res.status(400).send('Missing token or email.');
    }

    const record = await MagicLink.findOne({
      email: String(email).toLowerCase().trim(),
      token: String(magicToken),
      expiresAt: { $gt: new Date() },
    });

    if (!record) {
      return res.status(400).send(`
        <!DOCTYPE html><html><head><meta charset="utf-8"><title>Invalid link</title></head>
        <body style="font-family:sans-serif;padding:40px;text-align:center;background:#F8FAFC;">
          <h2>Link invalid or expired</h2>
          <p><a href="/login.html">Return to login</a></p>
        </body></html>`);
    }

    const user = await User.findOne({ email: record.email });
    if (!user) {
      return res.status(400).send('User not found.');
    }

    await MagicLink.deleteMany({ email: record.email, token: String(magicToken) });
    user.isVerified = true;
    await user.save();

    const userId = String(user._id);
    const sessionToken = issueToken(user);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Verified — IdeaVault</title>
  <style>body{font-family:Outfit,system-ui,sans-serif;background:#F8FAFC;color:#0F172A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  .box{text-align:center;padding:32px;background:#fff;border-radius:16px;border:1px solid #E2E8F0;box-shadow:0 2px 10px rgba(0,0,0,0.05);}
  .spinner{width:40px;height:40px;border:3px solid #E2E8F0;border-top-color:#6366F1;border-radius:50%;animation:spin 0.8s linear infinite;margin:16px auto;}
  @keyframes spin{to{transform:rotate(360deg)}}</style>
</head>
<body>
  <div class="box">
    <div style="font-size:20px;font-weight:700;background:linear-gradient(90deg,#6366F1,#3B82F6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">IdeaVault</div>
    <p>Email verified. Redirecting to your dashboard…</p>
    <div class="spinner"></div>
  </div>
  <script>
    try {
      localStorage.setItem('ideavault_userId', ${JSON.stringify(userId)});
      localStorage.setItem('ideavault_token', ${JSON.stringify(sessionToken)});
    } catch (e) {}
    setTimeout(function () {
      window.location.href = '/dashboard.html';
    }, 800);
  </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (e) {
    console.error(e);
    return res.status(500).send('Verification failed.');
  }
});

// ---------------------------------------------------------------------------
// JWT session
// ---------------------------------------------------------------------------
app.get('/api/auth/me', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    return res.json({ user: sanitizeUser(user) });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
app.get('/api/user/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    delete user.password;
    return res.json(user);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    if (payload.sub !== req.params.id) return res.status(403).json({ error: 'Forbidden' });

    const allowed = ['name', 'phone', 'dob', 'occupation', 'address', 'bio', 'image', 'experience'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    if (updates.dob) updates.dob = new Date(updates.dob);

    const user = await User.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(sanitizeUser(user));
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Update failed' });
  }
});

// ---------------------------------------------------------------------------
// Ideas (read paths for dashboard / explore)
// ---------------------------------------------------------------------------
app.get('/api/ideas', async (req, res) => {
  try {
    const publicOnly = String(req.query.publicOnly || '') === '1';
    const forDashboard = String(req.query.dashboard || '') === '1';
    
    let query = {};
    if (publicOnly) {
      query = { status: 'Published' };
    } else if (forDashboard) {
      let uid = null;
      try {
        const h = req.headers.authorization || '';
        const m = h.match(/^Bearer\s+(.+)$/i);
        if (m) uid = jwt.verify(m[1], JWT_SECRET).sub;
      } catch (e) {}
      if (uid) {
        query = {
          $or: [
            { userId: uid },
            { status: 'Published' }
          ]
        };
      } else {
        query = { status: 'Published' };
      }
    }

    const ideas = await Idea.find(query).lean();
    
    // Inject creator contact info for idea cards
    const users = await User.find({}, 'name email phone').lean();
    const userMap = {};
    for (const u of users) {
      userMap[String(u._id)] = u;
    }
    for (const idea of ideas) {
      const u = userMap[String(idea.userId)];
      if (u) {
        idea.email = idea.email || u.email;
        idea.phone = idea.phone || u.phone;
        idea.name = idea.name || u.name;
      }
    }

    let invMap = {};
    try {
      const invAgg = await Investment.aggregate([
        { $match: { status: { $nin: ['Rejected'] } } },
        { $group: { _id: '$ideaId', c: { $sum: 1 } } },
      ]);
      invMap = Object.fromEntries(invAgg.map((r) => [String(r._id), r.c]));
    } catch (e) {
      /* collection may not exist on first boot before any write */
    }
    const withMl = attachMlPacksToIdeas(ideas, invMap);
    const withScore = withMl.map((doc) => {
      const d = { ...doc };
      if (d.aiAnalysis && typeof d.aiAnalysis === 'object') {
        d.aiAnalysis = enrichAnalysisWithMl(d, JSON.parse(JSON.stringify(d.aiAnalysis)));
      }
      return {
        ...d,
        compositeScore: compositeScore(d),
      };
    });
    withScore.sort((a, b) => b.compositeScore - a.compositeScore);
    return res.json(withScore);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to load ideas' });
  }
});

const recentViews = new Map();

app.get('/api/ideas/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Not found' });

    const noView = String(req.query.noView || '') === '1';
    if (!noView) {
      idea.views = (idea.views || 0) + 1;
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const dayStr = today.toISOString().slice(0, 10);
      const vh = idea.viewsHistory || [];
      const hit = vh.find((h) => new Date(h.date).toISOString().slice(0, 10) === dayStr);
      if (hit) hit.count = (hit.count || 0) + 1;
      else vh.push({ date: today, count: 1 });
      idea.viewsHistory = vh;
      await idea.save();
      
      emitIdeaStats(idea._id);
    }

    const lean = idea.toObject();
    
    // Inject creator contact info
    const u = await User.findById(lean.userId, 'name email phone').lean();
    if (u) {
      lean.email = lean.email || u.email;
      lean.phone = lean.phone || u.phone;
      lean.name = lean.name || u.name;
    }

    // Inject latest FundingRound coordinates if any
    try {
      const activeRound = await FundingRound.findOne({ ideaId: idea._id }).sort({ createdAt: -1 }).lean();
      if (activeRound) {
        lean.fundraising = lean.fundraising || {};
        lean.fundraising.valuationUsd = activeRound.valuationUsd || 0;
        lean.fundraising.equityOffered = activeRound.equityOffered || 0;
        lean.fundraising.minInvestmentUsd = activeRound.minInvestmentUsd || 0;
      }
    } catch (err) {
      console.warn('[IdeaVault] Failed to merge active round coordinates:', err.message);
    }
    
    if (lean.aiAnalysis && typeof lean.aiAnalysis === 'object') {
      lean.aiAnalysis = enrichAnalysisWithMl(lean, JSON.parse(JSON.stringify(lean.aiAnalysis)));
    }
    lean.compositeScore = compositeScore(lean);
    let invC = 0;
    try {
      invC = await Investment.countDocuments({ ideaId: idea._id, status: { $nin: ['Rejected'] } });
    } catch (e) {
      /* noop */
    }
    const peerQuery = {
      status: 'Published',
      _id: { $ne: idea._id },
    };
    if (idea.category) peerQuery.category = idea.category;
    const publishedPeers = await Idea.find(peerQuery).select('title problem solution category status').limit(80).lean();
    lean.mlPack = buildMlPack(lean, { investmentCount: invC, publishedPeers });
    return res.json(lean);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

/** GET /api/ideas/:id/report */
app.get('/api/ideas/:id/report', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const idea = await Idea.findById(req.params.id).lean();
    if (!idea) return res.status(404).json({ error: 'Not found' });
    
    let founderName = idea.name || 'Founder';
    const u = await User.findById(idea.userId, 'name').lean();
    if (u) founderName = u.name;
    
    if (idea.aiAnalysis && typeof idea.aiAnalysis === 'object') {
      idea.aiAnalysis = enrichAnalysisWithMl(idea, JSON.parse(JSON.stringify(idea.aiAnalysis)));
    }
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(buildCreatorPackHtml(idea, founderName));
  } catch (e) {
    console.error(e);
    return res.status(500).send('Failed to generate report');
  }
});

/** POST /api/contact/email */
app.post('/api/contact/email', async (req, res) => {
  try {
    const { targetEmail, subject, message } = req.body;
    if (!targetEmail || !subject || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#6366f1;">IdeaVault Interaction</h2>
      <p><strong>Subject:</strong> ${escHtmlDoc(subject)}</p>
      <div style="padding:16px;background:#f8fafc;border-radius:8px;margin-top:16px;">
        <p style="white-space:pre-wrap;line-height:1.5;">${escHtmlDoc(message)}</p>
      </div>
      <p style="margin-top:20px;font-size:0.85em;color:#64748b;">This message was securely routed via the IdeaVault venture intelligence platform.</p>
    </div>`;
    
    await sendHtmlEmail(targetEmail, subject, html);
    return res.json({ success: true, message: 'Message sent securely via IdeaVault.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to send email' });
  }
});

/** POST /api/ideas (create) */
app.post('/api/ideas', async (req, res) => {
  try {
    const {
      userId,
      name,
      email,
      role,
      experience,
      title,
      category,
      tags,
      idealCustomer,
      problem,
      solution,
      summary,
      link,
      image,
      status,
    } = req.body;

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const normalizedTags = Array.isArray(tags)
      ? tags.map((t) => String(t).trim()).filter(Boolean)
      : typeof tags === 'string'
        ? tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [];

    const idea = await Idea.create({
      userId,
      name: name || '',
      email: email || '',
      role: role || '',
      experience: experience || '',
      title: String(title).trim(),
      category: category || '',
      tags: normalizedTags,
      idealCustomer: idealCustomer || '',
      problem: problem || '',
      solution: solution || '',
      summary: summary || '',
      link: link || '',
      image: image || '',
      status: status === 'Published' ? 'Published' : 'Draft',
      aiCache: {
        contentHash: '',
        summaryHash: '',
        analysisHash: '',
        roadmapHash: '',
        sentimentHash: '',
        updatedAt: new Date(),
      },
    });

    // Store content hash (used for AI caching)
    idea.aiCache.contentHash = computeIdeaContentHash(idea);
    idea.aiCache.updatedAt = new Date();

    // Spec: generate full AI suite immediately (best-effort, centralized)
    try {
      const results = await aiService.generateIdeaInsights(idea, ApiUsage);
      if (results) {
        idea.aiSummary = results.aiSummary;
        idea.aiAnalysis = results.aiAnalysis;
        idea.aiRoadmap = results.aiRoadmap;
        idea.aiCache.updatedAt = new Date();
      }
    } catch (e) {
      console.warn('[IdeaVault] Centralized AI generation failed:', e.message);
      if (!idea.aiSummary) idea.aiSummary = localSummarize(`${idea.problem} ${idea.solution}`, 3);
    }

    await idea.save();

    // Broadcast real-time system notification about the newly created idea to all users
    try {
      const creator = await User.findById(idea.userId).lean();
      const creatorName = (creator && creator.name) || 'A founder';
      const users = await User.find({}, '_id').lean();
      for (const u of users) {
        await Notification.create({
          userId: u._id,
          type: 'idea_created',
          text: `💡 New Venture Published: “${idea.title}” by ${creatorName} in ${idea.category || 'general'}.`,
          meta: { ideaId: String(idea._id) }
        });
      }
    } catch (err) {
      console.error('Failed to create idea notification:', err);
    }

    const out = idea.toObject();
    out.compositeScore = compositeScore(out);
    emitIdeaVaultLive(String(idea._id));
    return res.status(201).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Create failed' });
  }
});

/** PUT /api/ideas/:id */
app.put('/api/ideas/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);

    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (String(idea.userId) !== String(payload.sub)) {
      return res.status(403).json({ error: 'You can only edit your own ideas.' });
    }

    const allowed = [
      'name',
      'email',
      'role',
      'experience',
      'title',
      'category',
      'tags',
      'idealCustomer',
      'problem',
      'solution',
      'summary',
      'link',
      'image',
      'status',
      'vcTrack',
    ];
    for (const k of allowed) {
      if (req.body[k] === undefined) continue;
      if (k === 'vcTrack') {
        idea.vcTrack = Boolean(req.body.vcTrack);
        if (idea.vcTrack) idea.vcTrackSince = idea.vcTrackSince || new Date();
      } else if (k === 'tags') {
        const t = req.body.tags;
        idea.tags = Array.isArray(t)
          ? t.map((x) => String(x).trim()).filter(Boolean)
          : typeof t === 'string'
            ? t
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)
            : [];
      } else if (k === 'status') {
        idea.status = req.body.status === 'Published' ? 'Published' : 'Draft';
      } else {
        idea[k] = req.body[k];
      }
    }

    const newHash = computeIdeaContentHash(idea);
    const oldHash = idea.aiCache?.contentHash || '';
    const contentChanged = newHash !== oldHash;
    if (contentChanged) {
      // Invalidate AI caches if idea content changed
      idea.aiCache = {
        contentHash: newHash,
        summaryHash: '',
        analysisHash: '',
        roadmapHash: '',
        sentimentHash: '',
        updatedAt: new Date(),
      };
      idea.aiSummary = '';
      idea.aiAnalysis = null;
      idea.aiRoadmap = null;
      idea.aiSentiment = null;
    } else {
      idea.aiCache.updatedAt = new Date();
    }

    await idea.save();
    const out = idea.toObject();
    out.compositeScore = compositeScore(out);
    emitIdeaVaultLive(String(req.params.id));

    // Re-run AI analysis in background when content changed (non-blocking)
    if (contentChanged) {
      (async () => {
        try {
          const freshIdea = await Idea.findById(req.params.id);
          if (!freshIdea) return;
          const results = await aiService.generateIdeaInsights(freshIdea, ApiUsage);
          if (results) {
            freshIdea.aiSummary = results.aiSummary;
            freshIdea.aiAnalysis = results.aiAnalysis;
            freshIdea.aiRoadmap = results.aiRoadmap;
            freshIdea.aiCache.updatedAt = new Date();
            await freshIdea.save();
            emitIdeaVaultLive(String(req.params.id));
            console.log(`[IdeaVault] AI re-analysis complete for edited idea ${req.params.id}`);
          }
        } catch (aiErr) {
          console.warn(`[IdeaVault] Background AI re-analysis failed for idea ${req.params.id}:`, aiErr.message);
          // Fallback: at least restore a local summary so cards don't show empty
          try {
            const freshIdea = await Idea.findById(req.params.id);
            if (freshIdea && !freshIdea.aiSummary) {
              freshIdea.aiSummary = localSummarize(`${freshIdea.problem} ${freshIdea.solution}`, 3);
              await freshIdea.save();
            }
          } catch (_) {}
        }
      })();
    }

    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Update failed' });
  }
});

// ---------------------------------------------------------------------------
// VENTURE INTELLIGENCE & MATCHMAKING
// ---------------------------------------------------------------------------

/** GET /api/investors — List all investors from DB */
app.get('/api/investors', async (req, res) => {
  try {
    const list = await Investor.find({});
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch investors' });
  }
});

/** POST /api/investors — Admin/Internal to add investors */
app.post('/api/investors', async (req, res) => {
  try {
    const inv = new Investor(req.body);
    await inv.save();
    res.json(inv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/investors/match/:ideaId — Dynamic ML Match Ranking */
app.get('/api/investors/match/:ideaId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.ideaId)) return res.status(400).json({ error: 'Invalid idea id' });
    const idea = await Idea.findById(req.params.ideaId);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });

    const investors = await Investor.find({});
    const matches = investors.map(inv => {
      const score = calculateInvestorMatch(idea, inv);
      return {
        investor: inv,
        matchScore: score,
        matchLabel: score > 80 ? 'Perfect' : score > 60 ? 'Strong' : score > 40 ? 'Good' : 'Potential'
      };
    });

    matches.sort((a, b) => b.matchScore - a.matchScore);
    res.json(matches.slice(0, 10)); // Top 10 matches
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



/** DELETE /api/ideas/:id */
app.delete('/api/ideas/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);

    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (String(idea.userId) !== String(payload.sub)) {
      return res.status(403).json({ error: 'You can only delete your own ideas.' });
    }

    await Idea.findByIdAndDelete(req.params.id);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Delete failed' });
  }
});

/** PUT /api/ideas/:id/fundraising — owner only (manual raise tracker, no payment processor) */
app.put('/api/ideas/:id/fundraising', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (String(idea.userId) !== String(payload.sub)) return res.status(403).json({ error: 'Forbidden' });
    const goalUsd = Math.max(0, Number(req.body.goalUsd) || 0);
    const raisedUsd = Math.max(0, Number(req.body.raisedUsd) || 0);
    idea.fundraising = idea.fundraising || {};
    idea.fundraising.goalUsd = goalUsd;
    idea.fundraising.raisedUsd = raisedUsd;
    idea.fundraising.updatedAt = new Date();
    if (req.body.currency) idea.fundraising.currency = String(req.body.currency).slice(0, 8);
    await idea.save();
    emitIdeaVaultLive(String(req.params.id));
    return res.json({ fundraising: idea.fundraising });
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

/** POST /api/ideas/:id/creator-pack — full private report HTML (owner + JWT only) */
app.post('/api/ideas/:id/creator-pack', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const idea = await Idea.findById(req.params.id).lean();
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (String(idea.userId) !== String(payload.sub)) {
      return res.status(403).json({ error: 'Only the idea creator can download this pack.' });
    }
    const user = await User.findById(idea.userId).lean();
    const founderName = (user && user.name) || idea.name || 'Founder';
    let html = buildCreatorPackHtml(idea, founderName);
    try {
      const mentor = await callAiText(
        `Write one short paragraph (max 4 sentences) as a mentor to ${founderName}. Idea: ${idea.title}. Problem: ${(idea.problem || '').slice(0, 400)}. Solution: ${(idea.solution || '').slice(0, 400)}. Tie advice to execution and fundraising discipline. Plain text only.`,
        280,
      );
      html = html.replace(
        '</body>',
        `<div class="callout" style="margin-top:24px"><h2>Mentor note (AI)</h2><p>${escHtmlDoc(mentor.trim())}</p></div></body>`,
      );
    } catch (e) {
      /* optional */
    }
    return res.json({ html });
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

/** POST /api/ideas/check-duplicate */
app.post('/api/ideas/check-duplicate', async (req, res) => {
  try {
    const { title, category, problem, solution } = req.body;
    const t = String(title || '').toLowerCase();
    const p = String(problem || '').toLowerCase();
    const s = String(solution || '').toLowerCase();
    if (!t && !p && !s) {
      return res.status(400).json({ error: 'Provide title/problem/solution' });
    }

    const text = `${t} ${category || ''} ${p} ${s}`.trim();
    const words = new Set(
      text
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 3),
    );

    const published = await Idea.find({ status: 'Published' })
      .select('title category problem solution aiSummary userId name')
      .lean();

    function jaccard(a, b) {
      if (!a.size || !b.size) return 0;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter += 1;
      const union = a.size + b.size - inter;
      return union ? inter / union : 0;
    }

    let best = null;
    let bestSim = 0;
    for (const idea of published) {
      const otherText = `${idea.title || ''} ${idea.category || ''} ${idea.problem || ''} ${idea.solution || ''}`
        .toLowerCase()
        .trim();
      const other = new Set(
        otherText
          .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
          .split(/\s+/)
          .map((w) => w.trim())
          .filter((w) => w.length >= 3),
      );
      const sim = jaccard(words, other);
      if (sim > bestSim) {
        bestSim = sim;
        best = idea;
      }
    }

    const similarityPct = Math.round(bestSim * 1000) / 10;
    let isDuplicate = bestSim > 0.3;
    let aiVerdict = '';
    let differentiation = '';

    if (best && bestSim > 0.3) {
      try {
        const prompt = `You are checking startup idea overlap.\n\nCandidate:\nTitle: ${title}\nCategory: ${category}\nProblem: ${problem}\nSolution: ${solution}\n\nClosest match:\nTitle: ${best.title}\nCategory: ${best.category}\nProblem: ${best.problem}\nSolution: ${best.solution}\n\nAnswer in 3 short paragraphs:\n1) Verdict: Original / Overlap\n2) Why\n3) How to differentiate (2 bullet points max)`;
        const text2 = await callAiText(prompt, 380);
        aiVerdict = String(text2 || '').trim();
        differentiation = aiVerdict;
      } catch (e) {
        // ignore if AI not configured
      }
    }

    return res.json({
      isDuplicate,
      similarity: similarityPct,
      closestMatch: best
        ? {
            _id: best._id,
            title: best.title,
            category: best.category,
            userId: best.userId,
            name: best.name,
            aiSummary: best.aiSummary,
          }
        : null,
      aiVerdict,
      differentiation,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Check failed' });
  }
});

/** POST /api/ideas/:id/authenticity — VC Dashboard Authenticity Shield */
app.post('/api/ideas/:id/authenticity', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    
    let invC = 0;
    try {
      invC = await Investment.countDocuments({ ideaId: idea._id, status: { $nin: ['Rejected'] } });
    } catch(e){}
    
    const publishedPeers = await Idea.find({ status: 'Published', _id: { $ne: idea._id } }).select('title problem solution category status').limit(80).lean();
    const mlPack = buildMlPack(idea.toObject(), { investmentCount: invC, publishedPeers });
    const auth = mlPack.authenticity || { similarity: 0 };
    
    const plagiarismPct = auth.similarity;
    // Calculate a deterministic AI written heuristic
    const aiWrittenPct = Math.min(100, Math.round(15 + (mlPack.contentDepth || 50) * 0.7)); 
    const verdict = plagiarismPct > 30 ? 'High Overlap / Plagiarism Risk' : plagiarismPct > 15 ? 'Needs Differentiation' : 'Authentic';
    
    return res.json({
      plagiarismPct,
      aiWrittenPct,
      verdict,
      closestMatch: auth.closestMatch
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Authenticity check failed' });
  }
});

app.post('/api/ideas/:id/like', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    const uid = new mongoose.Types.ObjectId(userId);
    const idx = (idea.likes || []).findIndex((l) => String(l) === String(uid));
    if (idx >= 0) idea.likes.splice(idx, 1);
    else idea.likes.push(uid);
    await idea.save();
    emitIdeaStats(req.params.id);
    return res.json({
      likes: (idea.likes || []).map((x) => String(x)),
      liked: idx < 0,
      count: idea.likes.length,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/ideas/:id/comment', async (req, res) => {
  try {
    const { userId, user, text } = req.body;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'Comment text required' });
    }
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    idea.comments.push({
      userId: userId && mongoose.isValidObjectId(userId) ? userId : undefined,
      user: String(user || 'User').slice(0, 80),
      text: String(text).trim().slice(0, 2000),
      timestamp: new Date(),
    });
    await idea.save();

    // Best-effort: rerun sentiment cache (will be returned from /api/ai/sentiment)
    try {
      if (idea.comments && idea.comments.length) {
        const contentHash = computeIdeaContentHash(idea);
        const commentsHash = sha256(
          stableStringify(
            (idea.comments || []).map((c) => ({
              user: c.user,
              text: c.text,
              timestamp: c.timestamp,
            })),
          ),
        );
        const key = sha256(`sentiment:${contentHash}:${commentsHash}`);
        if (idea.aiCache?.sentimentHash !== key) {
          const prompt = `Analyze the sentiment of these community comments for a startup idea.\nReturn ONLY valid JSON.\n\nIdea title: ${idea.title}\nComments:\n${(idea.comments || [])
            .slice(-30)
            .map((c) => `- ${c.user || 'User'}: ${c.text}`)
            .join('\n')}\n\nJSON shape:\n{\n  \"overall\": string,\n  \"score\": number,\n  \"breakdown\": {\"positive%\": number, \"neutral%\": number, \"negative%\": number},\n  \"keyThemes\": string[],\n  \"topPositive\": string,\n  \"topConcern\": string,\n  \"recommendation\": string\n}`;
          const text2 = await callAiTextForJson(prompt, 900);
          const json = await parseAiJsonWithRepair(
            text2,
            'Comment sentiment JSON overall score breakdown keyThemes',
          );
          if (json) {
            idea.aiSentiment = json;
            idea.aiCache = idea.aiCache || {};
            idea.aiCache.contentHash = contentHash;
            idea.aiCache.sentimentHash = key;
            idea.aiCache.updatedAt = new Date();
            await idea.save();
          }
        }
      }
    } catch (e) {
      // ignore
    }

    emitIdeaStats(req.params.id);
    return res.json({ comments: idea.comments });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/ideas/:id/feedback', async (req, res) => {
  try {
    const { userId, userName, text, rating } = req.body;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    const entry = {
      userId: userId && mongoose.isValidObjectId(userId) ? userId : undefined,
      userName: String(userName || 'Anonymous').slice(0, 80),
      text: String(text || '').trim().slice(0, 2000),
      rating: Math.min(5, Math.max(0, Number(rating) || 0)),
      createdAt: new Date(),
    };
    idea.feedback.push(entry);
    await idea.save();

    const creator = await User.findById(idea.userId);
    if (creator && creator.email) {
      const stars = '★'.repeat(entry.rating) + '☆'.repeat(5 - entry.rating);
      await sendHtmlEmail(
        creator.email,
        `New feedback on “${idea.title}” — IdeaVault`,
        `<p style="font-family:Outfit,sans-serif;font-size:15px;"><strong>${entry.userName}</strong> left ${stars}</p><p style="font-size:15px;line-height:1.6;">${String(text || '').replace(/</g, '&lt;')}</p>`,
      );
    }
    return res.json({ ok: true, feedback: idea.feedback });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// AI routes (Claude) with MongoDB caching
// ---------------------------------------------------------------------------

app.post('/api/ai/summary', async (req, res) => {
  try {
    const { ideaId, force } = req.body;
    if (!mongoose.isValidObjectId(ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });
    const idea = await Idea.findById(ideaId);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (!canRunAiOnIdea(req, idea)) {
      return res.status(403).json({
        error: 'Sign in as the idea owner to run AI on drafts, or publish the idea first.',
      });
    }

    const contentHash = computeIdeaContentHash(idea);
    if (!idea.aiCache) idea.aiCache = {};
    if (!idea.aiCache.contentHash) idea.aiCache.contentHash = contentHash;
    const key = aiKey('summary', contentHash);

    if (!force && idea.aiSummary && idea.aiCache.summaryHash === key) {
      return res.json({ summary: idea.aiSummary, cached: true });
    }

    const prompt = `Write a 3-sentence executive summary for this startup idea: title=${idea.title}, category=${idea.category}, problem=${idea.problem}, solution=${idea.solution}. Be specific, no filler.`;
    const text = await callAiText(prompt, 320);
    idea.aiSummary = text;
    idea.aiCache.summaryHash = key;
    idea.aiCache.updatedAt = new Date();
    await idea.save();

    // Broadcast AI summary completion notification
    try {
      const users = await User.find({}, '_id').lean();
      for (const u of users) {
        await Notification.create({
          userId: u._id,
          type: 'ai_summary',
          text: `🤖 AI Executive Summary compiled successfully for “${idea.title}”!`,
          meta: { ideaId: String(idea._id) }
        });
      }
    } catch (err) {}

    return res.json({ summary: idea.aiSummary, cached: false });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'AI failed' });
  }
});

app.post('/api/ai/analysis', async (req, res) => {
  try {
    const { ideaId, force } = req.body;
    if (!mongoose.isValidObjectId(ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });
    const idea = await Idea.findById(ideaId);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (!canRunAiOnIdea(req, idea)) {
      return res.status(403).json({
        error: 'Sign in as the idea owner to run AI on drafts, or publish the idea first.',
      });
    }

    const contentHash = computeIdeaContentHash(idea);
    const key = aiKey('analysis', contentHash);
    if (!force && idea.aiAnalysis && idea.aiCache?.analysisHash === key) {
      return res.json({ analysis: idea.aiAnalysis, cached: true });
    }

    const inrNote = `Also include Indian Rupee (INR) equivalents for any dollar figures using ~${USD_TO_INR} INR per USD (e.g. "$1M (~₹83Cr)" or "approx ₹X lakhs").`;

    const prompt = `You are a world-class startup strategist and venture capitalist. Conduct a deep, exhaustive, and lengthy strategic analysis of the following startup idea. Return ONLY valid JSON (no markdown).

Idea:
Title: ${idea.title}
Category: ${idea.category}
Problem: ${idea.problem}
Solution: ${idea.solution}
Ideal customer: ${idea.idealCustomer}
Tags: ${(idea.tags || []).join(', ')}

${inrNote}

CRITICAL INSTRUCTION FOR FINANCIALS:
Do NOT use generic placeholders or standard defaults (like "$500K"). You MUST calculate a completely UNIQUE, mathematically plausible custom revenue projection (revenueY1, revenueY3, yoyGrowth) tailored specifically to this idea's business model, category, and target audience size.

Provide extensive detail for the marketSummary, strategicNarrative, futureTrends, techStack, and targetMarkets.

JSON shape:
{
  "marketSummary": string,
  "marketSize": string,
  "growthRate": string,
  "maturity": string,
  "innovationScore": number,
  "feasibilityScore": number,
  "riskScore": number,
  "competitorCount": number,
  "swot": {"strengths": string[], "weaknesses": string[], "opportunities": string[], "threats": string[]},
  "topRisks": [{"risk": string, "mitigation": string}],
  "revenueY1": string,
  "revenueY3": string,
  "yoyGrowth": string,
  "vcFitScore": number,
  "thesis": string,
  "futureTrends": string[],
  "techStack": string[],
  "targetMarkets": string[],
  "competitorNames": string[],
  "startupHealthScore": number,
  "explanation": string,
  "strategicNarrative": {
    "who": string,
    "what": string,
    "why": string,
    "how": string,
    "prevention": string
  },
  "hypeSignal": string,
  "marketTrendLine": string,
  "sentimentHint": string
}`;
    const text = await callAiTextForJson(prompt, 3500);
    const json = await parseAiJsonWithRepair(
      text,
      'Startup strategic analysis JSON with marketSummary, swot, scores, strategicNarrative who/what/why/how/prevention, revenue strings, topRisks array',
    );
    if (!json) return res.status(500).json({ error: 'AI did not return valid JSON' });

    idea.aiAnalysis = enrichAnalysisWithMl(idea, json);
    idea.aiCache = idea.aiCache || {};
    idea.aiCache.contentHash = contentHash;
    idea.aiCache.analysisHash = key;
    idea.aiCache.updatedAt = new Date();
    await idea.save();

    // Broadcast AI analysis completion notification
    try {
      const users = await User.find({}, '_id').lean();
      for (const u of users) {
        await Notification.create({
          userId: u._id,
          type: 'ai_analysis',
          text: `📊 AI Strategic SWOT and ML metrics computed successfully for “${idea.title}”!`,
          meta: { ideaId: String(idea._id) }
        });
      }
    } catch (err) {}

    return res.json({ analysis: json, cached: false });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'AI failed' });
  }
});

app.post('/api/ai/roadmap', async (req, res) => {
  try {
    const { ideaId, force } = req.body;
    if (!mongoose.isValidObjectId(ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });
    const idea = await Idea.findById(ideaId);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (!canRunAiOnIdea(req, idea)) {
      return res.status(403).json({
        error: 'Sign in as the idea owner to run AI on drafts, or publish the idea first.',
      });
    }

    const contentHash = computeIdeaContentHash(idea);
    const key = aiKey('roadmap', contentHash);
    if (!force && idea.aiRoadmap && idea.aiCache?.roadmapHash === key) {
      return res.json({ roadmap: idea.aiRoadmap, cached: true });
    }

    const prompt = `You are an expert product manager and venture builder. Return ONLY valid JSON for a highly detailed, comprehensive 4-phase product roadmap.\n\nIdea:\nTitle: ${idea.title}\nCategory: ${idea.category}\nProblem: ${idea.problem}\nSolution: ${idea.solution}\n\nFor every budget or cost field, give the budget strictly in Indian Rupees (INR) format (e.g., ₹50,000 or ₹10,00,000) and do NOT use Crores or Lakhs text, just the raw formatted number with commas. Do not include USD. Be very detailed in tasks and milestones.\n\nJSON shape:\n{\n  \"phases\": [{\"name\": string, \"duration\": string, \"budget\": string, \"tasks\": string[], \"milestone\": string, \"teamNeeded\": string[]}],\n  \"totalBudget\": string,\n  \"totalTimeline\": string,\n  \"techStack\": string[],\n  \"launchChannels\": string[],\n  \"kpis\": string[],\n  \"firstStep\": string,\n  \"marketEntry\": string,\n  \"riskMitigation\": string\n}`;
    const text = await callAiTextForJson(prompt, 3000);
    const json = await parseAiJsonWithRepair(
      text,
      '4-phase roadmap JSON with phases array (name,duration,budget,tasks,milestone,teamNeeded), totalBudget, totalTimeline, techStack, kpis',
    );
    if (!json) return res.status(500).json({ error: 'AI did not return valid JSON' });

    idea.aiRoadmap = json;
    idea.aiCache = idea.aiCache || {};
    idea.aiCache.contentHash = contentHash;
    idea.aiCache.roadmapHash = key;
    idea.aiCache.updatedAt = new Date();
    await idea.save();

    // Broadcast AI roadmap completion notification
    try {
      const users = await User.find({}, '_id').lean();
      for (const u of users) {
        await Notification.create({
          userId: u._id,
          type: 'ai_roadmap',
          text: `🗺️ AI Launch Roadmap and budget synthesized for “${idea.title}”!`,
          meta: { ideaId: String(idea._id) }
        });
      }
    } catch (err) {}

    return res.json({ roadmap: json, cached: false });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'AI failed' });
  }
});

app.post('/api/ai/generator', async (req, res) => {
  try {
    const { category, description } = req.body;
    if (!category || !description) {
      return res.status(400).json({ error: 'category and description are required' });
    }
    const key = sha256(`generator:${category}:${description}`);
    const existing = await AICache.findOne({ key }).lean();
    if (existing && existing.value) return res.json({ idea: existing.value, cached: true });

    const prompt = `You are an expert startup ideation assistant.\nReturn ONLY valid JSON.\nInput:\nCategory: ${category}\nDescription: ${description}\n\nJSON shape:\n{\n  \"title\": string,\n  \"problem\": string,\n  \"solution\": string,\n  \"idealCustomer\": string,\n  \"uniqueValue\": string,\n  \"tags\": string[],\n  \"category\": string,\n  \"innovationAngle\": string,\n  \"marketGap\": string\n}`;
    const text = await callAiTextForJson(prompt, 1600);
    const json = await parseAiJsonWithRepair(
      text,
      'Startup idea JSON: title, problem, solution, idealCustomer, uniqueValue, tags[], category, innovationAngle, marketGap',
    );
    if (!json) return res.status(500).json({ error: 'AI did not return valid JSON' });

    await AICache.findOneAndUpdate(
      { key },
      { $set: { key, value: json, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    return res.json({ idea: json, cached: false });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'AI failed' });
  }
});

/** POST /api/ai/build-similar — Groq-first cached sibling concept for Create Idea flow */
app.post('/api/ai/build-similar', aiUsageMiddleware, async (req, res) => {
  try {
    const userId = getBearerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { ideaId, force } = req.body || {};
    if (!mongoose.isValidObjectId(ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });
    const idea = await Idea.findById(ideaId).lean();
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (idea.status !== 'Published') {
      return res.status(403).json({ error: 'Build Similar is only available for published ideas.' });
    }

    const cacheKey = `buildsimilar:${ideaId}`;
    if (!force) {
      const hit = await AICache.findOne({ key: cacheKey }).lean();
      if (hit && hit.value && hit.updatedAt) {
        const age = Date.now() - new Date(hit.updatedAt).getTime();
        if (age < 14 * 86400000) return res.json({ ...hit.value, cached: true });
      }
    }

    const seed = {
      title: idea.title,
      category: idea.category,
      problem: idea.problem,
      solution: idea.solution,
      tags: idea.tags,
      idealCustomer: idea.idealCustomer,
    };
    const prompt = `You are a venture ideation expert.\nGiven this startup concept, invent ONE new DISTINCT sibling venture (different name and angle; do not copy).\nReturn ONLY valid JSON.\n\nSource:\n${JSON.stringify(
      seed,
    )}\n\nJSON shape:\n{\n  "title": string,\n  "category": string,\n  "problem": string,\n  "solution": string,\n  "tags": string[],\n  "idealCustomer": string,\n  "oneLineSummary": string\n}`;

    let text;
    try {
      text = await callGroq(prompt, 900, { jsonMode: true, temperature: 0.38 });
    } catch (groqErr) {
      console.warn('[IdeaVault] Groq build-similar fallback:', groqErr.message || groqErr);
      text = await callAiTextForJson(prompt, 900);
    }
    const json = await parseAiJsonWithRepair(text, 'sibling idea JSON');
    if (!json || !json.title) return res.status(500).json({ error: 'AI did not return a valid sibling idea' });

    await AICache.findOneAndUpdate(
      { key: cacheKey },
      {
        $set: { key: cacheKey, value: json, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    return res.json({ ...json, cached: false });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Build similar failed' });
  }
});

app.post('/api/ai/sentiment', async (req, res) => {
  try {
    const { ideaId, force } = req.body;
    if (!mongoose.isValidObjectId(ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });
    const idea = await Idea.findById(ideaId);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (!canRunAiOnIdea(req, idea)) {
      return res.status(403).json({
        error: 'Sign in as the idea owner to run AI on drafts, or publish the idea first.',
      });
    }
    if (!idea.comments || !idea.comments.length) {
      return res.json({ sentiment: null, cached: true });
    }

    const contentHash = computeIdeaContentHash(idea);
    const commentsHash = sha256(
      stableStringify(
        (idea.comments || []).map((c) => ({
          user: c.user,
          text: c.text,
          timestamp: c.timestamp,
        })),
      ),
    );
    const key = sha256(`sentiment:${contentHash}:${commentsHash}`);
    if (!force && idea.aiSentiment && idea.aiCache?.sentimentHash === key) {
      return res.json({ sentiment: idea.aiSentiment, cached: true });
    }

    const prompt = `Analyze the sentiment of these community comments for a startup idea.\nReturn ONLY valid JSON.\n\nIdea title: ${idea.title}\nComments:\n${(idea.comments || [])
      .slice(-30)
      .map((c) => `- ${c.user || 'User'}: ${c.text}`)
      .join('\n')}\n\nJSON shape:\n{\n  \"overall\": string,\n  \"score\": number,\n  \"breakdown\": {\"positive%\": number, \"neutral%\": number, \"negative%\": number},\n  \"keyThemes\": string[],\n  \"topPositive\": string,\n  \"topConcern\": string,\n  \"recommendation\": string\n}`;
    const text = await callAiTextForJson(prompt, 900);
    const json = await parseAiJsonWithRepair(
      text,
      'Comment sentiment JSON: overall, score, breakdown positive%/neutral%/negative%, keyThemes, recommendation',
    );
    if (!json) return res.status(500).json({ error: 'AI did not return valid JSON' });

    idea.aiSentiment = json;
    idea.aiCache = idea.aiCache || {};
    idea.aiCache.contentHash = contentHash;
    idea.aiCache.sentimentHash = key;
    idea.aiCache.updatedAt = new Date();
    await idea.save();
    return res.json({ sentiment: json, cached: false });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'AI failed' });
  }
});

app.post('/api/ai/vc-match', async (req, res) => {
  try {
    const { ideaId } = req.body;
    if (!mongoose.isValidObjectId(ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });
    const idea = await Idea.findById(ideaId).lean();
    if (!idea) return res.status(404).json({ error: 'Not found' });
    const investors = await Investor.find().lean();

    const contentHash = computeIdeaContentHash(idea);
    const invHash = sha256(
      stableStringify(
        investors.map((i) => ({
          _id: String(i._id),
          focus: i.focus,
          stagePreference: i.stagePreference,
          ticketSize: i.ticketSize,
          firm: i.firm,
          name: i.name,
        })),
      ),
    );
    const key = sha256(`vcmatch:${contentHash}:${invHash}`);
    const cached = await AICache.findOne({ key }).lean();
    if (cached && cached.value) return res.json({ matches: cached.value, cached: true });

    const out = computeVcRuleMatches(idea, investors);
    await AICache.findOneAndUpdate(
      { key },
      { $set: { key, value: out, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    return res.json({ matches: out, cached: false });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Match failed' });
  }
});

// ---------------------------------------------------------------------------
// Dashboard aggregates
// ---------------------------------------------------------------------------
app.get('/api/dashboard/stats/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const ideas = await Idea.find({ userId: req.params.userId }).lean();
    let totalLikes = 0;
    let totalComments = 0;
    let totalViews = 0;
    for (const i of ideas) {
      totalLikes += (i.likes && i.likes.length) || 0;
      totalComments += (i.comments && i.comments.length) || 0;
      totalViews += i.views || 0;
    }
    const publishedCount = ideas.filter((i) => i.status === 'Published').length;
    const draftCount = ideas.filter((i) => i.status === 'Draft').length;
    const totalIdeas = ideas.length;
    const engagementRate =
      totalViews > 0
        ? Math.round(((totalLikes + totalComments) / totalViews) * 1000) / 10
        : 0;
    const conversionRate =
      totalIdeas > 0 ? Math.round((publishedCount / totalIdeas) * 1000) / 10 : 0;

    return res.json({
      totalLikes,
      totalComments,
      totalViews,
      totalIdeas,
      publishedCount,
      draftCount,
      engagementRate,
      conversionRate,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/dashboard/weekly/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const ideas = await Idea.find({ userId: req.params.userId }).lean();
    const dayLabels = [];
    const counts = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      d.setUTCHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      dayLabels.push(names[d.getUTCDay()]);
      let sum = 0;
      for (const idea of ideas) {
        for (const h of idea.viewsHistory || []) {
          if (new Date(h.date).toISOString().slice(0, 10) === key) {
            sum += h.count || 0;
          }
        }
      }
      counts.push(sum);
    }
    return res.json({ labels: dayLabels, counts });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/dashboard/activity/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const uid = new mongoose.Types.ObjectId(req.params.userId);
    const uidStr = req.params.userId;
    const likedIdeas = await Idea.find({
      status: 'Published',
      $or: [{ likes: uid }, { likes: uidStr }],
    })
      .select('title category image views likes comments userId name')
      .lean();
    const commentedIdeas = await Idea.find({
      status: 'Published',
      $or: [{ 'comments.userId': uid }, { 'comments.userId': uidStr }],
    })
      .select('title category image views likes comments userId name')
      .lean();
    return res.json({ likedIdeas, commentedIdeas });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// AI — dashboard health narrative (2 sentences)
// ---------------------------------------------------------------------------
app.post('/api/ai/dashboard-health', async (req, res) => {
  try {
    const { statsText, stats } = req.body;
    if (!statsText && !stats) {
      return res.status(400).json({ error: 'statsText or stats required' });
    }
    const prompt = `You are an experienced startup advisor. Founder stats (may include engagement + innovation averages): ${statsText || JSON.stringify(stats)}.\nWrite exactly 2 sentences: (1) what the numbers say about traction and readiness, (2) one concrete next action. Be encouraging but honest. No bullet points.`;
    try {
      const text = await callAiText(prompt, 220);
      return res.json({ explanation: text.trim(), source: 'ai' });
    } catch (aiErr) {
      const fb = fallbackDashboardNarrative(stats);
      return res.json({
        explanation: fb + ' Live narrative AI is temporarily unavailable; your scores above still reflect stored engagement and ML.',
        source: 'ml+fallback',
        aiError: String(aiErr.message || ''),
      });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'AI unavailable' });
  }
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
function buildReportHtml(idea) {
  const ml = idea.mlPack || {};
  const analysis = idea.aiAnalysis || {};
  const roadmap = idea.aiRoadmap || { phases: [] };
  
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>IdeaVault Report - ${idea.title}</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      body { font-family: 'Outfit', sans-serif; color: #0f172a; line-height: 1.5; padding: 40px; max-width: 900px; margin: 0 auto; background: #fff; }
      .header { border-bottom: 2px solid #3b82f6; padding-bottom: 20px; margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
      .brand { font-size: 24px; font-weight: 700; color: #3b82f6; }
      .title { font-size: 32px; font-weight: 700; margin: 0; }
      .badge { display: inline-block; padding: 4px 12px; border-radius: 50px; background: #eff6ff; color: #3b82f6; font-size: 14px; font-weight: 600; margin-top: 8px; }
      .section { margin-bottom: 40px; page-break-inside: avoid; }
      .section-title { font-size: 20px; font-weight: 700; border-left: 4px solid #3b82f6; padding-left: 12px; margin-bottom: 16px; color: #1e293b; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
      .card { padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; }
      .score-box { text-align: center; padding: 20px; background: #3b82f6; color: #fff; border-radius: 16px; }
      .score-val { font-size: 48px; font-weight: 700; }
      .table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      .table th, .table td { text-align: left; padding: 12px; border-bottom: 1px solid #e2e8f0; }
      .footer { margin-top: 60px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; padding-top: 20px; }
      @media print { .no-print { display: none; } }
    </style>
  </head>
  <body>
    <div class="header">
      <div>
        <h1 class="title">${idea.title}</h1>
        <span class="badge">${idea.category}</span>
      </div>
      <div class="brand">IdeaVault</div>
    </div>

    <div class="section">
      <div class="section-title">Executive Summary</div>
      <p>${idea.aiSummary || idea.summary || 'Strategic overview pending.'}</p>
    </div>

    <div class="grid">
      <div class="score-box">
        <div style="font-size:14px;opacity:0.9">Idea Strength Score</div>
        <div class="score-val">${Math.round(compositeScore(idea))}</div>
        <div style="font-size:12px">out of 250</div>
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:8px">Market Dynamics</div>
        <div style="font-size:14px;color:#64748b">Maturity: <strong>${ml.marketMaturity || 'Varies'}</strong></div>
        <div style="font-size:14px;color:#64748b">Trend: <strong>${ml.marketTrend || 'Stable'}</strong></div>
        <div style="font-size:14px;color:#64748b">Sentiment: <strong>${ml.sentimentLabel || 'Neutral'}</strong></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Strategic Analysis</div>
      <div class="card">
        <p><strong>Thesis:</strong> ${analysis.marketSummary || 'N/A'}</p>
        <p><strong>Revenue Model:</strong> ${analysis.revenueModel || 'N/A'}</p>
        <p><strong>Projected Growth:</strong> ${analysis.yoyGrowth || 'N/A'}</p>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Venture Roadmap</div>
      <table class="table">
        <thead>
          <tr><th>Phase</th><th>Duration</th><th>Budget</th><th>Milestone</th></tr>
        </thead>
        <tbody>
          ${(roadmap.phases || []).map(p => `
            <tr>
              <td><strong>${p.name}</strong></td>
              <td>${p.duration}</td>
              <td>${p.budget}</td>
              <td>${p.milestone}</td>
            </tr>
          `).join('') || '<tr><td colspan="4" style="text-align:center;color:#94a3b8">Roadmap details pending AI generation.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="footer">
      Generated on ${new Date().toLocaleDateString()} &middot; IdeaVault Venture Intelligence Platform
      <div class="no-print" style="margin-top:10px">
        <button onclick="window.print()" style="background:#3b82f6;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer">Print to PDF</button>
      </div>
    </div>
  </body>
  </html>
  `;
}

app.get('/api/ideas/:id/report', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).send('Invalid ID');
    const idea = await Idea.findById(req.params.id).lean();
    if (!idea) return res.status(404).send('Idea not found');
    
    const invCount = await Investment.countDocuments({ ideaId: idea._id, status: { $ne: 'Rejected' } });
    idea.mlPack = buildMlPack(idea, { investmentCount: invCount });
    
    res.send(buildReportHtml(idea));
  } catch (e) {
    console.error(e);
    res.status(500).send('Report generation failed');
  }
});

app.get('/api/reports/pdf/:id', async (req, res) => {
  res.redirect(`/api/ideas/${req.params.id}/report`);
});


// ---------------------------------------------------------------------------
// User's ideas list (for profile page)
// ---------------------------------------------------------------------------
app.get('/api/ideas/user/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }
    const ideas = await Idea.find({ userId: req.params.userId }).lean();
    let invMap = {};
    try {
      const invAgg = await Investment.aggregate([
        { $match: { status: { $nin: ['Rejected'] } } },
        { $group: { _id: '$ideaId', c: { $sum: 1 } } },
      ]);
      invMap = Object.fromEntries(invAgg.map((r) => [String(r._id), r.c]));
    } catch (e) {
      /* noop */
    }
    const withMl = attachMlPacksToIdeas(ideas, invMap);
    const withScore = withMl.map((d) => {
      const doc = { ...d };
      if (doc.aiAnalysis && typeof doc.aiAnalysis === 'object') {
        doc.aiAnalysis = enrichAnalysisWithMl(doc, JSON.parse(JSON.stringify(doc.aiAnalysis)));
      }
      return { ...doc, compositeScore: compositeScore(doc) };
    });
    withScore.sort((a, b) => b.compositeScore - a.compositeScore);
    return res.json(withScore);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// Blogs
// ---------------------------------------------------------------------------
app.get('/api/blogs', async (req, res) => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 }).lean();
    return res.json(blogs);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/blogs/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const blog = await Blog.findById(req.params.id).lean();
    if (!blog) return res.status(404).json({ error: 'Not found' });
    return res.json(blog);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/blogs', async (req, res) => {
  try {
    const { userId, title, summary, content, category, image, readTime, featured } = req.body;
    if (!mongoose.isValidObjectId(userId)) return res.status(400).json({ error: 'Invalid userId' });
    if (!title) return res.status(400).json({ error: 'Title required' });
    const user = await User.findById(userId).lean();
    const blog = await Blog.create({
      userId,
      author: user ? user.name : '',
      authorImg: user && user.image ? user.image : '',
      title: String(title).trim(),
      summary: summary || '',
      content: content || '',
      category: category || '',
      image: image || '',
      readTime: readTime || '',
      featured: Boolean(featured),
    });
    return res.status(201).json(blog);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.put('/api/blogs/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const allowed = ['title', 'summary', 'content', 'category', 'image', 'readTime', 'featured'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    const blog = await Blog.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!blog) return res.status(404).json({ error: 'Not found' });
    return res.json(blog);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.delete('/api/blogs/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    await Blog.findByIdAndDelete(req.params.id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/blogs/:id/like', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: 'Not found' });
    const uid = new mongoose.Types.ObjectId(userId);
    const idx = (blog.likes || []).findIndex((l) => String(l) === String(uid));
    if (idx >= 0) blog.likes.splice(idx, 1);
    else blog.likes.push(uid);
    await blog.save();
    return res.json({ liked: idx < 0, count: blog.likes.length });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/blog-reviews/:blogId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.blogId)) return res.status(400).json({ error: 'Invalid id' });
    const reviews = await BlogReview.find({ blogId: req.params.blogId }).sort({ createdAt: -1 }).lean();
    return res.json(reviews);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/blog-reviews', async (req, res) => {
  try {
    const { blogId, userId, userName, rating, text } = req.body;
    if (!mongoose.isValidObjectId(blogId) || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating 1-5 required' });
    const review = await BlogReview.create({
      blogId,
      userId,
      userName: String(userName || 'User').slice(0, 80),
      rating: Number(rating),
      text: String(text || '').trim().slice(0, 1500),
    });
    return res.status(201).json(review);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// Analytics (per-user richer endpoint)
// ---------------------------------------------------------------------------
app.get('/api/analytics/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }
    const ideas = await Idea.find({ userId: req.params.userId }).lean();

    // Category distribution
    const catMap = {};
    for (const i of ideas) {
      const c = i.category || 'Other';
      catMap[c] = (catMap[c] || 0) + 1;
    }
    const categoryDist = Object.entries(catMap).map(([cat, count]) => ({ cat, count }));

    // Totals
    let totalLikes = 0, totalComments = 0, totalViews = 0;
    for (const i of ideas) {
      totalLikes += (i.likes && i.likes.length) || 0;
      totalComments += (i.comments && i.comments.length) || 0;
      totalViews += i.views || 0;
    }

    // 7-day daily views
    const dailyViews = [];
    const labels = [];
    for (let d = 6; d >= 0; d--) {
      const dt = new Date();
      dt.setUTCDate(dt.getUTCDate() - d);
      dt.setUTCHours(0, 0, 0, 0);
      const key = dt.toISOString().slice(0, 10);
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      labels.push(names[dt.getUTCDay()]);
      let sum = 0;
      for (const idea of ideas) {
        for (const h of idea.viewsHistory || []) {
          if (new Date(h.date).toISOString().slice(0, 10) === key) sum += h.count || 0;
        }
      }
      dailyViews.push(sum);
    }

    // Trending ideas (top 5 by composite score)
    const trending = ideas
      .map((i) => ({ ...i, compositeScore: compositeScore(i) }))
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, 5)
      .map((i) => ({ _id: i._id, title: i.title, category: i.category, compositeScore: Math.round(i.compositeScore * 10) / 10, likes: (i.likes || []).length, comments: (i.comments || []).length, views: i.views || 0 }));

    // Engagement + conversion
    const publishedCount = ideas.filter((i) => i.status === 'Published').length;
    const conversionRate = ideas.length > 0 ? Math.round((publishedCount / ideas.length) * 1000) / 10 : 0;
    const engagementRateRaw = totalViews > 0 ? ((totalLikes + totalComments * 2) / totalViews) * 100 : 0;
    const engagementDisplay = Math.min(95, Math.round(engagementRateRaw * 10) / 10);
    const engagementRate = engagementDisplay;
    const viewDepth = Math.min(1, totalViews / 80);

    // Sentiment per published idea
    const sentimentBreakdown = ideas
      .filter((i) => i.status === 'Published' && i.aiSentiment)
      .map((i) => ({
        _id: i._id,
        title: i.title,
        sentiment: i.aiSentiment,
      }));

    const momentumScore = Math.min(
      96,
      Math.round(
        engagementDisplay * 0.42 * viewDepth +
          conversionRate * 0.28 +
          Math.min(28, totalComments * 1.6) +
          Math.min(22, publishedCount * 2.8) +
          Math.min(18, Math.log10(12 + totalViews) * 6),
      ),
    );
    const mlInsights = {
      momentumScore,
      headline:
        publishedCount === 0
          ? 'Publish your first idea to unlock momentum tracking.'
          : `Momentum ${momentumScore}/100 blends reach depth (views), engagement (${engagementRate}% capped for thin traffic), publishing discipline, and discussion.`,
      bullets: [
        `Total views: ${totalViews} across ${ideas.length} idea(s). With few views, engagement % is capped so the index stays honest.`,
        `Likes ${totalLikes}, comments ${totalComments} — comments count double in the engagement ratio.`,
        publishedCount
          ? `${publishedCount} published — compare daily bars below to see which weekdays pull readers.`
          : 'Drafts do not accrue public reach until you publish.',
      ],
    };

    return res.json({
      categoryDist,
      trending,
      engagementRate,
      conversionRate,
      dailyViews,
      labels,
      totalLikes,
      totalComments,
      totalViews,
      totalIdeas: ideas.length,
      publishedCount,
      draftCount: ideas.length - publishedCount,
      sentimentBreakdown,
      mlInsights,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// Analytics AI Narrative — personalized portfolio insight via Groq/Gemini
// ---------------------------------------------------------------------------
app.get('/api/analytics/:userId/ai-narrative', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }
    const ideas = await Idea.find({ userId: req.params.userId }).lean();
    const published = ideas.filter(i => i.status === 'Published');
    const totalLikes = ideas.reduce((s, i) => s + ((i.likes && i.likes.length) || 0), 0);
    const totalComments = ideas.reduce((s, i) => s + ((i.comments && i.comments.length) || 0), 0);
    const totalViews = ideas.reduce((s, i) => s + (i.views || 0), 0);

    // Build a concise stats summary for the AI
    const topCategories = (() => {
      const cm = {};
      for (const i of ideas) cm[i.category || 'Other'] = (cm[i.category || 'Other'] || 0) + 1;
      return Object.entries(cm).sort((a,b) => b[1]-a[1]).slice(0,3).map(e => e[0]).join(', ');
    })();

    const avgInnovation = (() => {
      const scored = ideas.filter(i => i.aiAnalysis && i.aiAnalysis.innovationScore != null);
      if (!scored.length) return null;
      return (scored.reduce((s, i) => s + i.aiAnalysis.innovationScore, 0) / scored.length).toFixed(1);
    })();

    const engRate = totalViews > 0 ? ((totalLikes + totalComments * 2) / totalViews * 100).toFixed(1) : 0;

    const statsSummary = [
      `Total ideas: ${ideas.length} (${published.length} published, ${ideas.length - published.length} drafts).`,
      `Engagement: ${totalViews} views, ${totalLikes} likes, ${totalComments} comments. Engagement rate: ${engRate}%.`,
      `Top categories: ${topCategories || 'None yet'}.`,
      avgInnovation ? `Average AI innovation score across ${ideas.filter(i => i.aiAnalysis && i.aiAnalysis.innovationScore != null).length} analyzed idea(s): ${avgInnovation}/10.` : 'No AI innovation scores yet.',
    ].join(' ');

    // Check cache
    const cacheKey = `ana-narrative:${req.params.userId}:${SHA256quick(statsSummary)}`;
    const cached = await AICache.findOne({ key: cacheKey }).lean();
    if (cached && cached.value && cached.updatedAt && (Date.now() - new Date(cached.updatedAt).getTime() < 3 * 3600 * 1000)) {
      return res.json({ narrative: cached.value, cached: true });
    }

    const prompt = `You are an expert startup portfolio advisor analyzing an innovator's IdeaVault profile.

Portfolio stats: ${statsSummary}

Write a concise, insightful 3–4 sentence portfolio narrative covering:
1. What the data says about their current traction and innovation velocity.
2. One specific strength visible in the numbers.
3. One concrete, actionable recommendation to grow faster.

Be specific, encouraging but honest. Use plain text only — no bullet points, no markdown.`;

    let narrative;
    try {
      narrative = await callAiText(prompt, 320);
      narrative = String(narrative || '').trim();
    } catch (aiErr) {
      // Rule-based fallback
      narrative = [
        `You have ${ideas.length} idea(s) on IdeaVault, ${published.length} of which are published and accumulating real engagement signals.`,
        totalViews > 0
          ? `With ${totalViews} views and an engagement rate of ${engRate}%, your ideas are getting traction — keep sharing them in communities relevant to your top categories.`
          : `Your ideas have not yet attracted views — publish at least one and share it in founder communities and social channels to start collecting feedback.`,
        avgInnovation
          ? `Your average AI innovation score of ${avgInnovation}/10 suggests solid differentiation — run AI analysis on remaining ideas to surface more insights.`
          : `Run AI analysis on your published ideas to unlock innovation scores and strategic SWOT breakdowns.`,
      ].join(' ');
    }

    // Cache for 3 hours
    await AICache.findOneAndUpdate(
      { key: cacheKey },
      { $set: { key: cacheKey, value: narrative, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    return res.json({ narrative, cached: false });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// Simple non-crypto hash for cache keys (avoids importing crypto again)
function SHA256quick(str) {
  return sha256(String(str || '').slice(0, 500));
}

// ---------------------------------------------------------------------------
// Messaging (send email between users)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Messaging & Outreach
// ---------------------------------------------------------------------------
app.post('/api/messages', async (req, res) => {
  try {
    const { fromUserId, toEmail, subject, body } = req.body;
    if (!toEmail) return res.status(400).json({ error: 'toEmail required' });
    let fromName = 'IdeaVault user';
    if (fromUserId && mongoose.isValidObjectId(fromUserId)) {
      const u = await User.findById(fromUserId).lean();
      if (u) fromName = u.name;
    }
    await sendHtmlEmail(
      toEmail,
      subject || `Message from ${fromName} via IdeaVault`,
      `<div style="font-family:Outfit,sans-serif;padding:24px;border:1px solid #e2e8f0;border-radius:16px;background:#fff">
        <h2 style="margin:0 0 16px;color:#3b82f6">Message from ${fromName}</h2>
        <p style="font-size:15px;line-height:1.6;color:#334155">${String(body || '').replace(/\n/g, '<br />')}</p>
        <hr style="margin:24px 0;border-color:#e2e8f0"/>
        <p style="font-size:12px;color:#64748b">This message was sent via the IdeaVault Outreach Protocol. You can reply directly to this email or connect on the platform.</p>
      </div>`,
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Send failed' });
  }
});

// duplicate /api/contact/email removed — use the handler defined earlier with targetEmail + subject + message

// ---------------------------------------------------------------------------
// Investors & VC Matchmaking
// ---------------------------------------------------------------------------
app.get('/api/vc/matches/:ideaId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });
    const idea = await Idea.findById(req.params.ideaId).lean();
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    
    const investors = await Investor.find().lean();
    const matches = investors.map(inv => {
      const score = calculateInvestorMatch(idea, inv);
      return {
        _id: inv._id,
        name: inv.name,
        firm: inv.firm,
        focus: inv.focus,
        stagePreference: inv.stagePreference,
        ticketSize: inv.ticketSize,
        email: inv.email,
        website: inv.website,
        location: inv.location,
        score: score,
        matchPercent: score,
        reason: score > 80 ? 'High strategic alignment in sector and stage.' : 
                score > 60 ? 'Strong sectoral overlap with current traction.' : 
                'Moderate compatibility based on general thesis.'
      };
    }).sort((a, b) => b.score - a.score);
    
    return res.json(matches.slice(0, 10));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Matchmaking failed' });
  }
});


// ---------------------------------------------------------------------------
// Investors
// ---------------------------------------------------------------------------
app.get('/api/investors', async (req, res) => {
  try {
    const investors = await Investor.find().lean();
    return res.json(investors);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/investors', async (req, res) => {
  try {
    const inv = await Investor.create(req.body);
    return res.status(201).json(inv);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// VC pipeline (virtual deals — no payment rails in this build)
// ---------------------------------------------------------------------------

app.post('/api/vc/roi-simulate', async (req, res) => {
  try {
    const valuationInr = Math.max(100000, Number(req.body.valuationUsd) || 5000000);
    const investmentInr = Math.max(0, Number(req.body.amountUsd) || 500000);
    const equityPct = Math.max(0.01, Math.min(99, Number(req.body.equityPct) || 10));
    const ideaId = req.body.ideaId;
    
    let ideaContext = 'Hypothetical new venture in the IdeaVault ecosystem.';
    let tractionContext = 'Traction is moderate.';

    if (ideaId && mongoose.isValidObjectId(ideaId)) {
      const idea = await Idea.findById(ideaId).lean();
      if (idea) {
        ideaContext = `Idea Title: ${idea.title}\nCategory: ${idea.category}\nProblem: ${idea.problem}\nSolution: ${idea.solution}\nTarget: ${idea.idealCustomer}`;
        const views = idea.views || 0;
        const likes = (idea.likes && idea.likes.length) || 0;
        const comments = (idea.comments && idea.comments.length) || 0;
        const innovation = idea.aiAnalysis ? idea.aiAnalysis.innovationScore : 5;
        const vcFit = idea.aiAnalysis ? idea.aiAnalysis.vcFitScore : 50;
        tractionContext = `Views: ${views}, Likes: ${likes}, Comments: ${comments}, AI Innovation Score: ${innovation}/10, VC Fit Score: ${vcFit}/100`;
      }
    }

    const prompt = `You are an expert Venture Capital Machine Learning model running a predictive simulation for a startup investment.
    
Context about the startup:
${ideaContext}

Current Traction Metrics:
${tractionContext}

Investment Parameters (in INR):
- Current Valuation: ₹${valuationInr}
- Cheque Size: ₹${investmentInr}
- Equity Offered: ${equityPct}%

Please run a predictive Monte Carlo simulation / logistic regression assessment and return a JSON object with the following fields:
1. "projectedValuation5y" (number): The projected exit valuation of the company in 5 years (in INR).
2. "estimatedStakeValue5y" (number): The projected value of the investor's ${equityPct}% stake in 5 years (in INR).
3. "exitPotentialScore" (number): A score from 0 to 99 indicating the potential for a successful exit.
4. "successHeuristicPct" (number): A percentage (0-100) indicating the overall probability of startup success.
5. "method" (string): A 1-2 sentence description of the ML method used and the key drivers of this specific projection.

Output valid JSON only, with no markdown formatting.`;

    const aiRes = await callAiTextForJson(prompt, 800);
    let parsed;
    try {
      parsed = JSON.parse(aiRes);
    } catch(e) {
      // Fallback if parsing fails
      parsed = {
        projectedValuation5y: valuationInr * 3,
        estimatedStakeValue5y: (valuationInr * 3) * (equityPct/100),
        exitPotentialScore: 65,
        successHeuristicPct: 45,
        method: "Fallback heuristic used due to AI parsing error."
      };
    }

    return res.json({
      inputs: { valuationUsd: valuationInr, investmentAmount: investmentInr, equityPct, tractionScore: parsed.successHeuristicPct },
      projectedValuation5y: Number(parsed.projectedValuation5y) || (valuationInr * 3),
      estimatedStakeValue5y: Number(parsed.estimatedStakeValue5y) || ((valuationInr * 3) * (equityPct/100)),
      exitPotentialScore: Number(parsed.exitPotentialScore) || 50,
      successHeuristicPct: Number(parsed.successHeuristicPct) || 50,
      method: parsed.method || "Real-time AI evaluation using predictive VC models."
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }

});

app.get('/api/vc/idea-signals/:ideaId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.ideaId)) {
      return res.status(400).json({ error: 'Invalid idea id' });
    }
    const oid = new mongoose.Types.ObjectId(req.params.ideaId);
    const pipeline = await Investment.aggregate([
      { $match: { ideaId: oid, status: { $ne: 'Rejected' } } },
      { $group: { _id: '$status', c: { $sum: 1 } } },
    ]);
    const byStatus = {};
    let activeInterests = 0;
    for (const row of pipeline) {
      byStatus[row._id] = row.c;
      activeInterests += row.c;
    }
    const sumAmount = await Investment.aggregate([
      { $match: { ideaId: oid, status: 'Invested' } },
      { $group: { _id: null, total: { $sum: '$amountUsd' } } },
    ]);
    const committedUsd = sumAmount[0] && sumAmount[0].total ? Math.round(sumAmount[0].total) : 0;
    return res.json({ ideaId: String(req.params.ideaId), byStatus, activeInterests, committedUsd });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/vc/investments', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const { ideaId, status, amountUsd, equityPct, valuationUsd, note } = req.body;
    if (!mongoose.isValidObjectId(ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });
    const idea = await Idea.findById(ideaId).lean();
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    const allowed = ['Interested', 'PitchScheduled', 'DueDiligence', 'Invested', 'Rejected', 'Bookmarked'];
    const st = allowed.includes(String(status)) ? String(status) : 'Interested';
    const invId = new mongoose.Types.ObjectId(payload.sub);
    const ideaOid = new mongoose.Types.ObjectId(ideaId);
    const doc = await Investment.findOneAndUpdate(
      { investorUserId: invId, ideaId: ideaOid },
      {
        $set: {
          status: st,
          amountUsd: Math.max(0, Number(amountUsd) || 0),
          equityPct: Math.max(0, Math.min(100, Number(equityPct) || 0)),
          valuationUsd: Math.max(0, Number(valuationUsd) || 0),
          note: String(note || '').slice(0, 2000),
          updatedAt: new Date(),
        },
        $setOnInsert: { investorUserId: invId, ideaId: ideaOid, createdAt: new Date() },
      },
      { upsert: true, new: true },
    );

    await markIdeaVcTrack(ideaId);

    const investor = await User.findById(payload.sub).lean();
    const nm = (investor && investor.name) || 'An investor';

    // Broadcast VC staging updates to all users
    try {
      const formattedAmt = '₹' + Number(amountUsd).toLocaleString('en-IN');
      const users = await User.find({}, '_id').lean();
      for (const u of users) {
        await Notification.create({
          userId: u._id,
          type: 'vc',
          text: `🤝 VC Deal Alert: ${nm} updated pipeline on “${idea.title}” to ${st} stage (Cheque: ${formattedAmt}).`,
          meta: { ideaId: String(ideaId), investmentId: String(doc._id), status: st }
        });
      }
    } catch (err) {
      console.error('Failed to create VC notification:', err);
    }

    try {
      ioInstance && ioInstance.to('user:' + String(idea.userId)).emit('iv:notify', { text: `${nm} — ${st}` });
    } catch (e) {
      /* noop */
    }

    emitIdeaVaultLive(String(ideaId));
    return res.json(doc);
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/vc/investments/me', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);

    const query = { investorUserId: payload.sub };
    const { ideaId } = req.query;
    if (ideaId && mongoose.isValidObjectId(ideaId)) {
      query.ideaId = new mongoose.Types.ObjectId(ideaId);
    }

    const list = await Investment.find(query)
      .sort({ updatedAt: -1 })
      .populate('ideaId', 'title category status views likes userId email phone name vcTrack problem solution tags idealCustomer image aiSummary aiAnalysis mlPack fundraising')
      .lean();
    return res.json(list);
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

/** GET /api/vc/desk-idea-options — Published ideas on VC track or already in any investor pipeline */
app.get('/api/vc/desk-idea-options', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(m[1], JWT_SECRET);
    const inPipeline = await Investment.distinct('ideaId');
    const list = await Idea.find({
      status: 'Published'
    })
      .sort({ vcTrackSince: -1, createdAt: -1 })
      .select('title category vcTrack fundraising')
      .lean();
    return res.json(list);
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.patch('/api/vc/investments/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const doc = await Investment.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (String(doc.investorUserId) !== String(payload.sub)) return res.status(403).json({ error: 'Forbidden' });
    const allowed = ['Interested', 'PitchScheduled', 'DueDiligence', 'Invested', 'Rejected', 'Bookmarked'];
    if (req.body.status && allowed.includes(String(req.body.status))) doc.status = String(req.body.status);
    if (req.body.amountUsd != null) doc.amountUsd = Math.max(0, Number(req.body.amountUsd) || 0);
    if (req.body.equityPct != null) doc.equityPct = Math.max(0, Math.min(100, Number(req.body.equityPct) || 0));
    if (req.body.valuationUsd != null) doc.valuationUsd = Math.max(0, Number(req.body.valuationUsd) || 0);
    if (req.body.note != null) doc.note = String(req.body.note).slice(0, 2000);
    doc.updatedAt = new Date();
    await doc.save();
    await markIdeaVcTrack(String(doc.ideaId));

    const investor = await User.findById(payload.sub).lean();
    const nm = (investor && investor.name) || 'An investor';
    const idea = await Idea.findById(doc.ideaId).lean();
    const title = idea ? idea.title : 'Venture';

    // Broadcast VC staging update to all users
    try {
      const formattedAmt = '₹' + Number(doc.amountUsd).toLocaleString('en-IN');
      const users = await User.find({}, '_id').lean();
      for (const u of users) {
        await Notification.create({
          userId: u._id,
          type: 'vc',
          text: `🤝 VC Deal Alert: ${nm} updated pipeline on “${title}” to ${doc.status} stage (Cheque: ${formattedAmt}).`,
          meta: { ideaId: String(doc.ideaId), investmentId: String(doc._id), status: doc.status }
        });
      }
    } catch (err) {
      console.error('Failed to create VC notification:', err);
    }

    emitIdeaVaultLive(String(doc.ideaId));
    return res.json(doc);
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/vc/dashboard-stats/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid user id' });
    const uid = new mongoose.Types.ObjectId(req.params.userId);
    const { ideaId } = req.query;

    const match = { investorUserId: uid };
    if (ideaId && mongoose.isValidObjectId(ideaId)) {
      match.ideaId = new mongoose.Types.ObjectId(ideaId);
    }

    const byStatus = await Investment.aggregate([
      { $match: match },
      { $group: { _id: '$status', c: { $sum: 1 } } },
    ]);
    const statusMap = {};
    let total = 0;
    for (const r of byStatus) {
      statusMap[r._id] = r.c;
      total += r.c;
    }

    const investMatch = { investorUserId: uid, status: 'Invested' };
    if (ideaId && mongoose.isValidObjectId(ideaId)) {
      investMatch.ideaId = new mongoose.Types.ObjectId(ideaId);
    }

    const sums = await Investment.aggregate([
      { $match: investMatch },
      { $group: { _id: null, t: { $sum: '$amountUsd' } } },
    ]);
    const deployedUsd = sums[0] && sums[0].t ? Math.round(sums[0].t) : 0;
    return res.json({ totalDeals: total, byStatus: statusMap, deployedUsd });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/notifications/unread-count/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid id' });
    const count = await Notification.countDocuments({ userId: req.params.userId, read: false });
    return res.json({ count });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/notifications/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid id' });
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    if (payload.sub !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });
    const items = await Notification.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(50).lean();
    return res.json(items);
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const n = await Notification.findById(req.params.id);
    if (!n) return res.status(404).json({ error: 'Not found' });
    if (String(n.userId) !== String(payload.sub)) return res.status(403).json({ error: 'Forbidden' });
    n.read = true;
    await n.save();
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/notifications/read-all/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid id' });
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    if (payload.sub !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });
    await Notification.updateMany({ userId: req.params.userId }, { $set: { read: true } });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// Fundraising Round — Launch / Update
// ---------------------------------------------------------------------------
app.post('/api/fundraising/round', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const { ideaId, targetAmountUsd, valuationUsd, equityOffered, minInvestmentUsd } = req.body;
    if (!mongoose.isValidObjectId(ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });
    const idea = await Idea.findById(ideaId);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    if (String(idea.userId) !== String(payload.sub)) return res.status(403).json({ error: 'Only the founder can launch a round' });

    // Values come in as INR from frontend; store natively as INR in the goalUsd field
    const goalInr = Math.max(0, Number(targetAmountUsd) || 0);
    const valInr  = Math.max(0, Number(valuationUsd) || 0);
    const minInr  = Math.max(0, Number(minInvestmentUsd) || 0);
    const eq      = Math.max(0, Math.min(100, Number(equityOffered) || 0));

    idea.fundraising = {
      goalUsd: goalInr,       // storing INR value in this field (legacy field name kept)
      raisedUsd: idea.fundraising ? (idea.fundraising.raisedUsd || 0) : 0,
      minInvestmentUsd: minInr,
      valuationUsd: valInr,
      equityOffered: eq,
      currency: 'INR',
      updatedAt: new Date(),
    };
    await idea.save();

    // Upsert FundingRound doc
    await FundingRound.findOneAndUpdate(
      { ideaId: idea._id },
      { $set: { founderId: payload.sub, targetAmountUsd: goalInr, minInvestmentUsd: minInr, equityOffered: eq, valuationUsd: valInr, active: true } },
      { upsert: true, new: true }
    );

    emitIdeaVaultLive(String(ideaId));
    return res.json({ ok: true, fundraising: idea.fundraising });
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') return res.status(401).json({ error: 'Invalid token' });
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// Transactions — list for an idea
// ---------------------------------------------------------------------------
app.get('/api/ideas/:id/transactions', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const txns = await Transaction.find({ ideaId: req.params.id })
      .sort({ createdAt: -1 })
      .populate('userId', 'name email image')
      .lean();
    return res.json(txns);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// Payments — Create Razorpay Order
// ---------------------------------------------------------------------------
app.post('/api/payments/order', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const { amountUsd, ideaId } = req.body;
    if (!mongoose.isValidObjectId(ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });

    // amountUsd here is actually INR (frontend sends INR)
    const amountInr = Math.round(Math.max(1, Number(amountUsd) || 1) * 100); // paise
    const options = {
      amount: amountInr,
      currency: 'INR',
      receipt: `iv_${Date.now()}`,
      notes: { ideaId: String(ideaId), userId: String(payload.sub) },
    };
    const order = await razorpay.orders.create(options);

    // Create pending transaction
    await Transaction.create({
      userId: payload.sub,
      ideaId,
      amountUsd: amountInr / 100,
      amountInr: amountInr / 100,
      razorpayOrderId: order.id,
      status: 'Pending',
    });

    return res.json({ orderId: order.id, amount: order.amount, currency: order.currency });
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') return res.status(401).json({ error: 'Invalid token' });
    return res.status(500).json({ error: e.message || 'Failed to create order' });
  }
});

// ---------------------------------------------------------------------------
// Payments — Manual Confirm (UPI / Bank / Card simulation)
// ---------------------------------------------------------------------------
app.post('/api/payments/manual-confirm', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const { amountUsd, ideaId } = req.body;
    if (!mongoose.isValidObjectId(ideaId)) return res.status(400).json({ error: 'Invalid ideaId' });

    // amountUsd field from frontend carries INR value
    const amountInr = Math.max(1, Number(amountUsd) || 1) * USD_TO_INR;
    const amountStored = Math.round(Number(amountUsd) || 0);

    const idea = await Idea.findById(ideaId);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });

    // Record the transaction
    const txn = await Transaction.create({
      userId: payload.sub,
      ideaId,
      amountUsd: amountStored,
      amountInr: amountStored,
      status: 'Success',
    });

    // Update raised amount on the idea
    idea.fundraising = idea.fundraising || {};
    idea.fundraising.raisedUsd = (idea.fundraising.raisedUsd || 0) + amountStored;
    idea.fundraising.updatedAt = new Date();
    idea.markModified('fundraising');
    await idea.save();

    // Notify founder
    try {
      const investor = await User.findById(payload.sub).lean();
      const nm = (investor && investor.name) || 'An investor';
      await Notification.create({
        userId: idea.userId,
        type: 'payment',
        text: `💰 Payment Alert: ${nm} pledged ₹${Number(amountStored).toLocaleString('en-IN')} to "${idea.title}".`,
        meta: { ideaId: String(ideaId), transactionId: String(txn._id), amount: amountStored }
      });
    } catch (ne) { /* noop */ }

    emitIdeaVaultLive(String(ideaId));
    return res.json({ ok: true, transactionId: txn._id, status: 'Success' });
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') return res.status(401).json({ error: 'Invalid token' });
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// Payments — Verify Razorpay Signature
// ---------------------------------------------------------------------------
app.post('/api/payments/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const secret = process.env.RAZORPAY_KEY_SECRET || '';
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(body).digest('hex');

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ status: 'failed', error: 'Signature mismatch' });
    }

    // Mark pending transaction as success
    const txn = await Transaction.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id },
      { $set: { razorpayPaymentId: razorpay_payment_id, status: 'Success' } },
      { new: true }
    );

    if (txn && txn.ideaId) {
      const idea = await Idea.findById(txn.ideaId);
      if (idea) {
        idea.fundraising = idea.fundraising || {};
        idea.fundraising.raisedUsd = (idea.fundraising.raisedUsd || 0) + (txn.amountUsd || 0);
        idea.fundraising.updatedAt = new Date();
        idea.markModified('fundraising');
        await idea.save();
        emitIdeaVaultLive(String(txn.ideaId));
      }
    }

    return res.json({ status: 'success' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ status: 'failed', error: e.message || 'Verification failed' });
  }
});

// ---------------------------------------------------------------------------
// Funding Analytics — Per-User Investment Dashboard (for analytics page)
// ---------------------------------------------------------------------------
app.get('/api/funding/analytics/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);

    const uid = req.params.userId;

    // All transactions by this user (as investor)
    const myTxns = await Transaction.find({ userId: uid, status: 'Success' })
      .populate('ideaId', 'title category fundraising userId')
      .sort({ createdAt: -1 })
      .lean();

    // All ideas owned by this user — check their fundraising
    const myIdeas = await Idea.find({ userId: uid }).lean();
    const myRounds = await FundingRound.find({ founderId: uid }).populate('ideaId', 'title category').lean();

    // VC pipeline investments this user made
    const vcInvestments = await Investment.find({ investorUserId: uid })
      .populate('ideaId', 'title category aiAnalysis views likes')
      .sort({ updatedAt: -1 })
      .lean();

    // All transactions received by founder's ideas
    const myIdeaIds = myIdeas.map(i => i._id);
    const receivedTxns = await Transaction.find({ ideaId: { $in: myIdeaIds }, status: 'Success' })
      .populate('userId', 'name email')
      .populate('ideaId', 'title')
      .sort({ createdAt: -1 })
      .lean();

    // Totals
    const totalInvested = myTxns.reduce((s, t) => s + (t.amountInr || t.amountUsd || 0), 0);
    const totalRaised   = receivedTxns.reduce((s, t) => s + (t.amountInr || t.amountUsd || 0), 0);
    const totalVcCommitted = vcInvestments
      .filter(v => v.status === 'Invested')
      .reduce((s, v) => s + (v.amountUsd || 0), 0);

    // Per-idea fundraising progress
    const ideaFundingStatus = myIdeas.filter(i => i.fundraising && i.fundraising.goalUsd > 0).map(i => {
      const f = i.fundraising;
      const pct = f.goalUsd > 0 ? Math.min(100, Math.round((f.raisedUsd / f.goalUsd) * 100)) : 0;
      return {
        _id: i._id,
        title: i.title,
        category: i.category,
        goalInr: f.goalUsd,
        raisedInr: f.raisedUsd || 0,
        pct,
        equityOffered: f.equityOffered || 0,
        valuationInr: f.valuationUsd || 0,
        minInvestmentInr: f.minInvestmentUsd || 0,
        status: i.status,
      };
    });

    // ML-based VC fit insights
    const vcFitInsights = vcInvestments.map(v => {
      const idea = v.ideaId || {};
      const ai = idea.aiAnalysis || {};
      const views = idea.views || 0;
      const likes = (idea.likes || []).length;
      const vcFit = ai.vcFitScore || 50;
      const innov = ai.innovationScore || 5;
      const z = -2.2 + (vcFit * 0.035) + (innov * 0.12) + (likes * 0.15) + (Math.log10(views + 1) * 0.22);
      const successPct = Math.round((1 / (1 + Math.exp(-z))) * 100);
      return {
        ideaTitle: idea.title || 'Unknown',
        ideaCategory: idea.category || '',
        status: v.status,
        amountInr: v.amountUsd || 0,
        equityPct: v.equityPct || 0,
        valuationInr: v.valuationUsd || 0,
        successPct,
        vcFit,
        innovationScore: innov,
        updatedAt: v.updatedAt,
      };
    });

    // 30-day transaction timeline
    const txnTimeline = [];
    for (let d = 29; d >= 0; d--) {
      const dt = new Date();
      dt.setUTCDate(dt.getUTCDate() - d);
      dt.setUTCHours(0, 0, 0, 0);
      const key = dt.toISOString().slice(0, 10);
      const sum = [...myTxns, ...receivedTxns].filter(t => {
        return new Date(t.createdAt).toISOString().slice(0, 10) === key;
      }).reduce((s, t) => s + (t.amountInr || t.amountUsd || 0), 0);
      txnTimeline.push({ date: key, amount: sum });
    }

    return res.json({
      totalInvested,
      totalRaised,
      totalVcCommitted,
      myTransactions: myTxns,
      receivedPayments: receivedTxns,
      vcInvestments: vcFitInsights,
      ideaFundingStatus,
      txnTimeline,
      myRounds,
    });
  } catch (e) {
    console.error(e);
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') return res.status(401).json({ error: 'Invalid token' });
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// Data Migration — fix old USD-stored fundraising values → native INR
// ---------------------------------------------------------------------------
app.post('/api/admin/migrate-fundraising-inr', async (req, res) => {
  try {
    const ideas = await Idea.find({ 'fundraising.goalUsd': { $gt: 0, $lt: 10000 } });
    let updated = 0;
    for (const idea of ideas) {
      if (idea.fundraising && idea.fundraising.currency !== 'INR') {
        idea.fundraising.goalUsd      = Math.round((idea.fundraising.goalUsd || 0) * USD_TO_INR);
        idea.fundraising.raisedUsd    = Math.round((idea.fundraising.raisedUsd || 0) * USD_TO_INR);
        idea.fundraising.valuationUsd = Math.round((idea.fundraising.valuationUsd || 0) * USD_TO_INR);
        idea.fundraising.minInvestmentUsd = Math.round((idea.fundraising.minInvestmentUsd || 0) * USD_TO_INR);
        idea.fundraising.currency = 'INR';
        idea.markModified('fundraising');
        await idea.save();
        updated++;
      }
    }
    return res.json({ ok: true, updated, message: `Migrated ${updated} idea(s) from USD to INR` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// ROI Save — store simulation results for history
// ---------------------------------------------------------------------------
const roiHistorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ideaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Idea' },
  inputs: { type: mongoose.Schema.Types.Mixed },
  results: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});
const RoiHistory = mongoose.model('RoiHistory', roiHistorySchema);

app.post('/api/vc/roi-save', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const { ideaId, inputs, results } = req.body;
    const doc = await RoiHistory.create({
      userId: payload.sub,
      ideaId: mongoose.isValidObjectId(ideaId) ? ideaId : undefined,
      inputs, results
    });
    return res.json({ ok: true, _id: doc._id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/vc/roi-history', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(m[1], JWT_SECRET);
    const list = await RoiHistory.find({ userId: payload.sub })
      .populate('ideaId', 'title')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    return res.json(list);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Funding Analytics — 1-day snapshot
// ---------------------------------------------------------------------------
app.get('/api/funding/today/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid userId' });
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(m[1], JWT_SECRET);
    const uid = req.params.userId;
    const todayStart = new Date(); todayStart.setUTCHours(0,0,0,0);

    const myIdeas = await Idea.find({ userId: uid }, '_id').lean();
    const myIdeaIds = myIdeas.map(i => i._id);

    const [sentToday, receivedToday, vcToday] = await Promise.all([
      Transaction.find({ userId: uid, status: 'Success', createdAt: { $gte: todayStart } })
        .populate('ideaId', 'title').lean(),
      Transaction.find({ ideaId: { $in: myIdeaIds }, status: 'Success', createdAt: { $gte: todayStart } })
        .populate('userId', 'name').populate('ideaId', 'title').lean(),
      Investment.find({ investorUserId: uid, updatedAt: { $gte: todayStart } })
        .populate('ideaId', 'title category').lean()
    ]);

    return res.json({
      sentToday,
      receivedToday,
      vcToday,
      totalSentToday:     sentToday.reduce((s,t) => s+(t.amountInr||t.amountUsd||0), 0),
      totalReceivedToday: receivedToday.reduce((s,t) => s+(t.amountInr||t.amountUsd||0), 0),
      vcDealsToday:       vcToday.length
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Root → splash
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.redirect('/logo.html');
});

// ---------------------------------------------------------------------------
// Investor seed (runs after DB connect)
// ---------------------------------------------------------------------------
const INVESTOR_SEED = [
  {
    name: 'Sequoia Capital India',
    firm: 'Sequoia Capital India',
    focus: ['SaaS', 'FinTech', 'EdTech'],
    stagePreference: ['Seed', 'Series A'],
    ticketSize: '$500K-$5M',
    email: 'india@sequoiacap.com',
    website: 'https://sequoiacap.com',
    portfolio: ["BYJU's", 'Razorpay'],
    description: 'Leading global VC with strong India presence',
    location: 'Bangalore',
  },
  {
    name: 'Accel India',
    firm: 'Accel',
    focus: ['SaaS', 'HealthTech', 'AI/ML'],
    stagePreference: ['Seed', 'Series A', 'Series B'],
    ticketSize: '$1M-$10M',
    email: 'info@accel.com',
    website: 'https://accel.com',
    portfolio: ['Flipkart', 'Freshworks'],
    description:
      'Accel India partners with technical founders building category-defining software and applied AI. The team leads with partner-led diligence, rapid feedback, and deep hiring and GTM support across India and Southeast Asia.',
    thesis:
      'Back durable SaaS, data infrastructure, and vertical AI where founders show clear wedge and repeatable expansion motion.',
    sweetSpot: 'Seed through Series B; first institutional cheque through growth rounds for B2B and select consumer infra.',
    process:
      'Initial partner meeting → deep dive on product, unit economics, and market → reference calls → term sheet. Portfolio platform helps with cloud credits, senior hires, and global customer intros.',
    location: 'Bangalore',
  },
  {
    name: 'Kalaari Capital',
    firm: 'Kalaari Capital',
    focus: ['EdTech', 'HealthTech', 'CleanTech'],
    stagePreference: ['Seed', 'Series A'],
    ticketSize: '$500K-$3M',
    email: 'info@kalaari.com',
    website: 'https://kalaari.com',
    portfolio: ['Dream11', 'Urban Ladder'],
    description: 'India-focused early stage VC',
    location: 'Bangalore',
  },
  {
    name: 'Blume Ventures',
    firm: 'Blume Ventures',
    focus: ['AI/ML', 'SaaS', 'AgriTech'],
    stagePreference: ['Pre-Seed', 'Seed'],
    ticketSize: '$100K-$1M',
    email: 'info@blume.vc',
    website: 'https://blume.vc',
    portfolio: ['Unacademy', 'Slice'],
    description: 'Seed stage India VC',
    location: 'Mumbai',
  },
  {
    name: 'Matrix Partners India',
    firm: 'Matrix Partners India',
    focus: ['FinTech', 'SaaS', 'E-commerce'],
    stagePreference: ['Series A', 'Series B'],
    ticketSize: '$2M-$15M',
    email: 'india@matrixpartners.com',
    website: 'https://matrixpartners.in',
    portfolio: ['OYO', 'Ola'],
    description: 'Growth stage VC',
    location: 'Mumbai',
  },
  {
    name: 'Nexus Venture Partners',
    firm: 'Nexus Venture Partners',
    focus: ['SaaS', 'HealthTech', 'Web3'],
    stagePreference: ['Seed', 'Series A'],
    ticketSize: '$500K-$5M',
    email: 'info@nexusvp.com',
    website: 'https://nexusvp.com',
    portfolio: ['Delhivery', 'Postman'],
    description: 'Enterprise and consumer tech investor',
    location: 'Mumbai',
  },
  {
    name: 'Y Combinator',
    firm: 'Y Combinator',
    focus: ['AI/ML', 'SaaS', 'Social Impact'],
    stagePreference: ['Pre-Seed', 'Seed'],
    ticketSize: '$500K',
    email: 'apply@ycombinator.com',
    website: 'https://ycombinator.com',
    portfolio: ['Airbnb', 'Stripe', 'Dropbox'],
    description: "World's top startup accelerator",
    location: 'San Francisco',
  },
  {
    name: 'Tiger Global',
    firm: 'Tiger Global',
    focus: ['FinTech', 'E-commerce', 'SaaS'],
    stagePreference: ['Series B', 'Series C'],
    ticketSize: '$10M-$100M',
    email: 'info@tigerglobal.com',
    website: 'https://tigerglobal.com',
    portfolio: ['Flipkart', 'Freshworks', 'Meesho'],
    description: 'Late stage global growth investor',
    location: 'New York',
  },
];

async function seedInvestorsIfEmpty() {
  const count = await Investor.countDocuments();
  if (count === 0) {
    await Investor.insertMany(INVESTOR_SEED);
    console.log('[IdeaVault] Seeded', INVESTOR_SEED.length, 'investors.');
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
async function start() {
  await mongoose.connect(MONGODB_URI);
  console.log('[IdeaVault] MongoDB connected:', MONGODB_URI);
  await seedInvestorsIfEmpty();

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
  });
  io.on('connection', (socket) => {
    socket.on('subscribe:user', (uid) => {
      if (uid && mongoose.isValidObjectId(String(uid))) {
        socket.join('user:' + String(uid));
      }
    });
  });
  ioInstance = io;

  server.listen(PORT, () => {
    console.log(`[IdeaVault] Server http://localhost:${PORT}`);
    const g = getActiveGeminiKey();
    const sk = process.env.ANTHROPIC_API_KEY && String(process.env.ANTHROPIC_API_KEY).trim();
    if (g) console.log('[IdeaVault] AI: Google Gemini (primary: ' + geminiModelCandidates()[0] + ')');
    else if (sk && sk.startsWith('sk-ant')) console.log('[IdeaVault] AI: Anthropic Claude');
    else console.warn('[IdeaVault] AI: no valid GEMINI_API_KEY or ANTHROPIC_API_KEY — AI routes will error until configured.');
    console.log('[IdeaVault] Socket.io live refresh enabled.');
    console.log(
      '[IdeaVault] Auth + JWT + ideas + dashboard routes active (see server.js)',
    );
  });
}

start().catch((err) => {
  console.error('[IdeaVault] Failed to start:', err);
  process.exit(1);
});

module.exports = { app, User, MagicLink, Idea, Investor, Blog, BlogReview, ApiUsage, callAiText };
