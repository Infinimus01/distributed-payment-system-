const logger = require('../utils/logger');
const { StatusCodes } = require('http-status-codes');

/**
 * Payment Routes - Proxy to Payment Service
 */
class PaymentRoutes {
    constructor(serviceProxy) {
        this.serviceProxy = serviceProxy;
    }

    /**
     * POST /api/payments
     * Create payment
     */
    async createPayment(req, res, next) {
        try {
            const result = await this.serviceProxy.forwardToPaymentService(
                'POST',
                '/payments',
                req.body,
                {
                    'idempotency-key': req.headers['idempotency-key'] || req.headers['x-idempotency-key']
                }
            );

            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/payments/:paymentId/process
     * Process payment
     */
    async processPayment(req, res, next) {
        try {
            const { paymentId } = req.params;

            const result = await this.serviceProxy.forwardToPaymentService(
                'POST',
                `/payments/${paymentId}/process`,
                req.body
            );

            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/payments/:paymentId/refund
     * Refund payment
     */
    async refundPayment(req, res, next) {
        try {
            const { paymentId } = req.params;

            const result = await this.serviceProxy.forwardToPaymentService(
                'POST',
                `/payments/${paymentId}/refund`,
                req.body
            );

            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/payments/:paymentId
     * Get payment details
     */
    async getPayment(req, res, next) {
        try {
            const { paymentId } = req.params;

            const result = await this.serviceProxy.forwardToPaymentService(
                'GET',
                `/payments/${paymentId}`
            );

            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/payments/user/:userId
     * Get payments by user
     */
    async getPaymentsByUser(req, res, next) {
        try {
            const { userId } = req.params;
            const { limit, offset } = req.query;

            const queryString = new URLSearchParams({ limit, offset }).toString();
            const path = `/payments/user/${userId}${queryString ? '?' + queryString : ''}`;

            const result = await this.serviceProxy.forwardToPaymentService('GET', path);

            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }
}

module.exports = PaymentRoutes;
