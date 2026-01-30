const logger = require('../utils/logger');
const { StatusCodes } = require('http-status-codes');

/**
 * Rate Limiting Middleware
 * 
 * Implements sliding window rate limiting using Redis
 * 
 * ALGORITHM:
 * - Key: ratelimit:{apiKey}:{window}
 * - Window: Current minute (e.g., 2024-01-30T10:05)
 * - Counter: Incremented on each request
 * - TTL: Window duration + buffer
 * 
 * FEATURES:
 * - Per-API-key rate limiting
 * - Configurable limits per tier
 * - Automatic key expiration
 * - Graceful degradation if Redis fails
 */
function rateLimiter(redisClient, config) {
    return async (req, res, next) => {
        const apiKey = req.apiKey;
        const apiKeyInfo = req.apiKeyInfo;

        if (!apiKey || !apiKeyInfo) {
            // Should not happen if apiKeyAuth middleware ran first
            return next();
        }

        // Get rate limit for this API key
        const maxRequests = apiKeyInfo.maxRequests || config.rateLimit.maxRequests;
        const windowMs = config.rateLimit.windowMs;

        // Generate window key (e.g., "2024-01-30T10:05")
        const now = Date.now();
        const windowStart = Math.floor(now / windowMs) * windowMs;
        const windowKey = `ratelimit:${apiKey}:${windowStart}`;

        try {
            // Increment request counter
            const requestCount = await redisClient.incr(windowKey);

            // Set TTL on first request in window
            if (requestCount === 1) {
                const ttlSeconds = Math.ceil((windowMs + 10000) / 1000); // Window + 10s buffer
                await redisClient.expire(windowKey, ttlSeconds);
            }

            // Calculate remaining requests
            const remaining = Math.max(0, maxRequests - requestCount);
            const resetTime = windowStart + windowMs;

            // Add rate limit headers
            res.setHeader('X-RateLimit-Limit', maxRequests);
            res.setHeader('X-RateLimit-Remaining', remaining);
            res.setHeader('X-RateLimit-Reset', Math.ceil(resetTime / 1000));

            logger.debug('Rate limit check', {
                apiKey: apiKey.substring(0, 10) + '...',
                requestCount,
                maxRequests,
                remaining,
                window: new Date(windowStart).toISOString()
            });

            // Check if rate limit exceeded
            if (requestCount > maxRequests) {
                logger.warn('Rate limit exceeded', {
                    apiKey: apiKey.substring(0, 10) + '...',
                    name: apiKeyInfo.name,
                    requestCount,
                    maxRequests,
                    method: req.method,
                    path: req.path
                });

                return res.status(StatusCodes.TOO_MANY_REQUESTS).json({
                    success: false,
                    error: 'RATE_LIMIT_EXCEEDED',
                    message: `Rate limit exceeded. Maximum ${maxRequests} requests per ${windowMs / 1000} seconds.`,
                    retryAfter: Math.ceil((resetTime - now) / 1000)
                });
            }

            next();
        } catch (error) {
            // If Redis fails, log error but allow request (graceful degradation)
            logger.error('Rate limiter error', {
                error: error.message,
                apiKey: apiKey.substring(0, 10) + '...'
            });

            // Add warning header
            res.setHeader('X-RateLimit-Status', 'degraded');

            next();
        }
    };
}

module.exports = rateLimiter;
