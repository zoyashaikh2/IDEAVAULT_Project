/**
 * Rate Limiter for AI requests.
 * Enforces a delay between requests and prevents parallel calls.
 */
class RateLimiter {
    constructor() {
        this.lastRequestTime = 0;
        this.isProcessing = false;
        this.minInterval = parseInt(process.env.AI_REQUEST_INTERVAL) || 8000;
    }

    async acquire() {
        while (this.isProcessing) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;

        if (timeSinceLast < this.minInterval) {
            const waitTime = this.minInterval - timeSinceLast;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.isProcessing = true;
    }

    release() {
        this.lastRequestTime = Date.now();
        this.isProcessing = false;
    }
}

module.exports = new RateLimiter();
