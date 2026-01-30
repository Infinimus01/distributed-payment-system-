const logger = require('../utils/logger');

/**
 * Event Publisher - Publishes payment events to Redis pub/sub
 */
class EventPublisher {
    constructor(redisClient) {
        this.redis = redisClient;
    }

    /**
     * Publish PaymentCreated event
     */
    async publishPaymentCreated(payment) {
        const event = {
            eventType: 'PaymentCreated',
            eventId: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            payload: {
                paymentId: payment.id,
                userId: payment.userId,
                amount: payment.amount,
                currency: payment.currency,
                status: payment.status,
                merchantId: payment.merchantId,
                idempotencyKey: payment.idempotencyKey,
                createdAt: payment.createdAt
            }
        };

        try {
            await this.redis.publish('payment-events', event);
            logger.info('PaymentCreated event published', {
                eventId: event.eventId,
                paymentId: payment.id
            });
        } catch (error) {
            logger.error('Failed to publish PaymentCreated event', {
                error: error.message,
                paymentId: payment.id
            });
            // Don't throw - event publishing failure shouldn't fail the payment
        }
    }

    /**
     * Publish PaymentStatusChanged event
     */
    async publishPaymentStatusChanged(payment, previousStatus) {
        const event = {
            eventType: 'PaymentStatusChanged',
            eventId: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            payload: {
                paymentId: payment.id,
                userId: payment.userId,
                previousStatus,
                newStatus: payment.status,
                amount: payment.amount,
                currency: payment.currency,
                updatedAt: payment.updatedAt
            }
        };

        try {
            await this.redis.publish('payment-events', event);
            logger.info('PaymentStatusChanged event published', {
                eventId: event.eventId,
                paymentId: payment.id,
                status: payment.status
            });
        } catch (error) {
            logger.error('Failed to publish PaymentStatusChanged event', {
                error: error.message,
                paymentId: payment.id
            });
        }
    }

    /**
     * Publish generic payment event
     */
    async publishEvent(eventType, payload) {
        const event = {
            eventType,
            eventId: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            payload
        };

        try {
            await this.redis.publish('payment-events', event);
            logger.info('Event published', {
                eventType,
                eventId: event.eventId
            });
        } catch (error) {
            logger.error('Failed to publish event', {
                error: error.message,
                eventType
            });
        }
    }
}

module.exports = EventPublisher;
