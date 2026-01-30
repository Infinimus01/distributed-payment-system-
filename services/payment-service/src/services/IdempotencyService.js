const logger = require('../utils/logger');

/**
 * Idempotency Service - Handles idempotency using Redis
 */
class IdempotencyService {
    constructor(redisClient, ttlSeconds = 86400) {
        this.redis = redisClient;
        this.ttl = ttlSeconds; // Default: 24 hours
    }

    /**
     * Check if idempotency key exists and return cached payment
     */
    async getPayment(idempotencyKey) {
        try {
            const cacheKey = `idempotency:${idempotencyKey}`;
            const cached = await this.redis.get(cacheKey);

            if (cached) {
                logger.info('Idempotency cache hit', { idempotencyKey });
                return cached;
            }

            logger.debug('Idempotency cache miss', { idempotencyKey });
            return null;
        } catch (error) {
            logger.error('Error checking idempotency cache', {
                error: error.message,
                idempotencyKey
            });
            // Don't throw - allow request to proceed if Redis fails
            return null;
        }
    }

    /**
     * Store payment in idempotency cache
     */
    async storePayment(idempotencyKey, payment) {
        try {
            const cacheKey = `idempotency:${idempotencyKey}`;
            await this.redis.set(cacheKey, payment, this.ttl);

            logger.info('Payment stored in idempotency cache', {
                idempotencyKey,
                paymentId: payment.id,
                ttl: this.ttl
            });
        } catch (error) {
            logger.error('Error storing payment in idempotency cache', {
                error: error.message,
                idempotencyKey
            });
            // Don't throw - payment was already created in DB
        }
    }

    /**
     * Delete idempotency key (for testing or manual cleanup)
     */
    async deletePayment(idempotencyKey) {
        try {
            const cacheKey = `idempotency:${idempotencyKey}`;
            await this.redis.del(cacheKey);
            logger.info('Idempotency cache entry deleted', { idempotencyKey });
        } catch (error) {
            logger.error('Error deleting idempotency cache entry', {
                error: error.message,
                idempotencyKey
            });
        }
    }
}

module.exports = IdempotencyService;
