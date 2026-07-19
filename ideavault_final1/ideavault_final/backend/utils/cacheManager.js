/**
 * Cache Manager for AI responses.
 */
class CacheManager {
    async getCachedIdeaData(idea) {
        if (!idea) return null;

        // Check if AI fields already exist and are not empty
        const hasSummary = !!idea.aiSummary;
        const hasAnalysis = !!idea.aiAnalysis;
        const hasRoadmap = !!idea.aiRoadmap;

        if (hasSummary && hasAnalysis && hasRoadmap) {
            return {
                aiSummary: idea.aiSummary,
                aiAnalysis: idea.aiAnalysis,
                aiRoadmap: idea.aiRoadmap,
                fromCache: true
            };
        }

        return null;
    }

    async saveToCache(idea, data) {
        if (!idea || !data) return;

        if (data.aiSummary) idea.aiSummary = data.aiSummary;
        if (data.aiAnalysis) idea.aiAnalysis = data.aiAnalysis;
        if (data.aiRoadmap) idea.aiRoadmap = data.aiRoadmap;

        idea.aiCache = idea.aiCache || {};
        idea.aiCache.updatedAt = new Date();
        
        await idea.save();
    }
}

module.exports = new CacheManager();
