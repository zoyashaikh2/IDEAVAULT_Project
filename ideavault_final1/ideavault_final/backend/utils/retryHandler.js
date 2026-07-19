/**
 * Retry and Fallback handler for AI requests.
 */
class RetryHandler {
    constructor() {
        this.maxRetries = 2;
        this.retryDelay = 2000;
    }

    async execute(fn, context = {}) {
        let lastError = null;
        const models = [
            process.env.GEMINI_MODEL || 'gemini-2.0-flash',
            process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite'
        ];

        for (const model of models) {
            for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
                try {
                    return await fn(model);
                } catch (error) {
                    lastError = error;
                    const isQuotaError = error.message?.toLowerCase().includes('quota') || 
                                       error.message?.toLowerCase().includes('limit reached') ||
                                       error.status === 429;

                    if (isQuotaError) {
                        console.warn(`[RetryHandler] Quota exceeded for model ${model}.`);
                        // If it's a quota error, we might want to try the next model immediately
                        break; 
                    }

                    console.error(`[RetryHandler] Attempt ${attempt} failed for model ${model}:`, error.message);
                    
                    if (attempt < this.maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
                    }
                }
            }
        }

        throw lastError;
    }
}

module.exports = new RetryHandler();
