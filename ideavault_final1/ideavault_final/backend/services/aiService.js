const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const rateLimiter = require('../utils/rateLimiter');
const retryHandler = require('../utils/retryHandler');
const cacheManager = require('../utils/cacheManager');
const requestQueue = require('../utils/requestQueue');

const { groqApiKeyList } = require('../utils/groqKeys');

class AIService {
    constructor() {
        this.geminiKey = process.env.GEMINI_API_KEY;
        this.genAI = this.geminiKey ? new GoogleGenerativeAI(this.geminiKey) : null;
    }

    async callGroq(prompt, jsonMode = true) {
        const keys = groqApiKeyList();
        if (!keys.length) throw new Error('Groq API key not set (use GROQ_API_KEY and/or GROQ_API_KEY_2)');
        const groqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
        let lastErr = null;
        for (const groqKey of keys) {
            try {
                const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${groqKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: groqModel,
                        messages: [{ role: 'user', content: prompt }],
                        response_format: jsonMode ? { type: 'json_object' } : undefined,
                        temperature: 0.1
                    })
                });
                const data = await response.json();
                if (!response.ok || data.error) {
                    const msg = data.error?.message || JSON.stringify(data);
                    lastErr = new Error(`Groq error: ${msg}`);
                    const retryable =
                        response.status === 429 ||
                        response.status === 401 ||
                        /rate|quota|limit|invalid|unauthor/i.test(String(msg));
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

    async generateIdeaInsights(idea, ApiUsageModel) {
        const cached = await cacheManager.getCachedIdeaData(idea);
        if (cached) return cached;

        return requestQueue.add(async () => {
            await rateLimiter.acquire();
            const startTime = Date.now();
            let success = false;
            let isQuotaExceeded = false;
            let provider = 'gemini';

            try {
                const results = await retryHandler.execute(async (modelName) => {
                    const summaryPrompt = `Write a 3-sentence executive summary for this startup idea: title=${idea.title}, category=${idea.category}, problem=${idea.problem}, solution=${idea.solution}. Be specific, no filler.`;
                    
                    const analysisPrompt = `Return ONLY valid JSON for this startup idea.
                    Idea: ${idea.title}, Category: ${idea.category}, Problem: ${idea.problem}, Solution: ${idea.solution}
                    
                    Requirements:
                    1. All monetary values in Indian Rupees (₹).
                    2. "explanation": Provide EXACTLY 4-5 lines of deep strategic narrative about why this idea is strong or what it needs.
                    3. "marketTrend": A short descriptive string (e.g. "Upward / High Demand").
                    
                    JSON shape:
                    {
                      "marketSummary": string,
                      "marketSize": string,
                      "maturity": string,
                      "innovationScore": number,
                      "feasibilityScore": number,
                      "riskScore": number,
                      "swot": {"strengths": string[], "weaknesses": string[], "opportunities": string[], "threats": string[]},
                      "topRisks": [{"risk": string, "mitigation": string}],
                      "vcFitScore": number,
                      "explanation": string,
                      "strategicGuidelines": string[],
                      "marketEntryStrategy": string,
                      "marketTrend": string,
                      "revenueModel": string,
                      "revenueY1": string,
                      "yoyGrowth": string
                    }`;

                    const roadmapPrompt = `Return ONLY valid JSON for product roadmap in INR (₹).
                    Idea: ${idea.title}
                    JSON shape:
                    {
                      "phases": [{"name": string, "duration": string, "budget": string, "tasks": string[], "milestone": string}],
                      "totalBudget": string,
                      "totalTimeline": string,
                      "firstStep": string
                    }`;

                    let summary, analysis, roadmap;

                    try {
                        // Try Gemini first
                        const model = this.genAI.getGenerativeModel({ model: modelName });
                        const [sR, aR, rR] = await Promise.all([
                            model.generateContent(summaryPrompt),
                            model.generateContent(analysisPrompt),
                            model.generateContent(roadmapPrompt)
                        ]);
                        summary = sR.response.text();
                        analysis = JSON.parse(this.cleanJson(aR.response.text()));
                        roadmap = JSON.parse(this.cleanJson(rR.response.text()));
                    } catch (e) {
                        console.warn("Gemini failed, falling back to Groq:", e.message);
                        provider = 'groq';
                        // Fallback to Groq
                        const [sT, aT, rT] = await Promise.all([
                            this.callGroq(summaryPrompt, false),
                            this.callGroq(analysisPrompt, true),
                            this.callGroq(roadmapPrompt, true)
                        ]);
                        summary = sT;
                        analysis = JSON.parse(aT);
                        roadmap = JSON.parse(rT);
                    }

                    return { summary, analysis, roadmap };
                });

                success = true;
                const data = {
                    aiSummary: results.summary,
                    aiAnalysis: results.analysis,
                    aiRoadmap: results.roadmap
                };

                await cacheManager.saveToCache(idea, data);
                return { ...data, fromCache: false };

            } catch (error) {
                success = false;
                isQuotaExceeded = error.message?.toLowerCase().includes('quota') || error.status === 429;
                return { 
                    aiSummary: idea.aiSummary || "AI services temporarily limited.",
                    aiAnalysis: idea.aiAnalysis,
                    aiRoadmap: idea.aiRoadmap,
                    isError: true,
                    error: error.message,
                    fromCache: true 
                };
            } finally {
                const duration = Date.now() - startTime;
                await this.updateApiTracking(ApiUsageModel, { success, duration, isQuotaExceeded });
                rateLimiter.release();
            }
        });
    }

    cleanJson(text) {
        let cleaned = text.trim();
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }
        return cleaned.trim();
    }

    async updateApiTracking(ApiUsageModel, { success, duration, isQuotaExceeded }) {
        if (!ApiUsageModel) return;
        const today = new Date().toISOString().slice(0, 10);
        let usage = await ApiUsageModel.findOne({});
        if (!usage) usage = new ApiUsageModel();
        if (usage.lastResetDate !== today) {
            usage.requestsToday = 0;
            usage.lastResetDate = today;
        }
        usage.totalRequests += 1;
        usage.requestsToday += 1;
        if (!success) usage.failedRequests += 1;
        if (isQuotaExceeded) usage.quotaErrors += 1;
        usage.avgResponseTime = (usage.avgResponseTime * (usage.totalRequests - 1) + duration) / usage.totalRequests;
        await usage.save();
    }
}

module.exports = new AIService();
