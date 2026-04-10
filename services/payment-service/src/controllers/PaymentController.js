const logger = require('../utils/logger');
const { StatusCodes } = require('http-status-codes');

/**
 * Payment Controller - HTTP request handlers
 */
class PaymentController {
    constructor(paymentService, paymentProcessor, reconciliationService, anomalyDetector) {
        this.paymentService = paymentService;
        this.paymentProcessor = paymentProcessor;
        this.reconciliationService = reconciliationService;
        this.anomalyDetector = anomalyDetector;
    }

    /**
     * POST /payments
     * Create a new payment
     */
    async createPayment(req, res, next) {
        try {
            const {
                userId,
                amount,
                currency,
                merchantId,
                description,
                metadata
            } = req.body;

            // Get idempotency key from header
            const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

            if (!idempotencyKey) {
                return res.status(StatusCodes.BAD_REQUEST).json({
                    success: false,
                    error: 'INVALID_INPUT',
                    message: 'Idempotency-Key header is required'
                });
            }

            // Validate required fields
            if (!userId || !amount || !currency || !merchantId) {
                return res.status(StatusCodes.BAD_REQUEST).json({
                    success: false,
                    error: 'INVALID_INPUT',
                    message: 'userId, amount, currency, and merchantId are required'
                });
            }

            const result = await this.paymentService.createPayment({
                userId,
                amount,
                currency,
                merchantId,
                description,
                metadata,
                idempotencyKey
            });

            // Anomaly check — run after payment created, non-blocking
            if (this.anomalyDetector && !result.duplicate) {
                try {
                    const anomaly = await this.anomalyDetector.check(result.payment);
                    await this.anomalyDetector.record(result.payment);
                    if (anomaly.flagged) {
                        logger.warn('ANOMALY DETECTED', {
                            paymentId: result.payment.id,
                            userId: result.payment.userId,
                            amount: result.payment.amount,
                            reason: anomaly.reason,
                            severity: anomaly.severity,
                        });
                    }
                } catch (anomalyErr) {
                    logger.warn('Anomaly check failed', { error: anomalyErr.message });
                }
            }

            // Return 200 for duplicates, 201 for new payments
            const statusCode = result.duplicate ? StatusCodes.OK : StatusCodes.CREATED;

            res.status(statusCode).json({
                success: true,
                data: {
                    payment: {
                        id: result.payment.id,
                        userId: result.payment.userId,
                        amount: result.payment.amount,
                        currency: result.payment.currency,
                        status: result.payment.status,
                        merchantId: result.payment.merchantId,
                        description: result.payment.description,
                        createdAt: result.payment.createdAt
                    },
                    duplicate: result.duplicate,
                    source: result.source
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /payments/:paymentId/process
     * Process payment with wallet debit
     */
    async processPayment(req, res, next) {
        try {
            const { paymentId } = req.params;
            const { walletId } = req.body;

            if (!walletId) {
                return res.status(StatusCodes.BAD_REQUEST).json({
                    success: false,
                    error: 'INVALID_INPUT',
                    message: 'walletId is required'
                });
            }

            // Get payment
            const payment = await this.paymentService.getPayment(paymentId);

            // Check if already processed
            if (payment.status === 'COMPLETED') {
                return res.status(StatusCodes.OK).json({
                    success: true,
                    data: {
                        payment: {
                            id: payment.id,
                            status: payment.status,
                            processedAt: payment.processedAt
                        },
                        message: 'Payment already completed'
                    }
                });
            }

            if (payment.status === 'FAILED') {
                return res.status(StatusCodes.UNPROCESSABLE_ENTITY).json({
                    success: false,
                    error: 'PAYMENT_ALREADY_FAILED',
                    message: 'Payment has already failed',
                    failureReason: payment.failureReason
                });
            }

            // Process payment
            const result = await this.paymentProcessor.processPayment(payment, walletId);

            if (result.success) {
                res.status(StatusCodes.OK).json({
                    success: true,
                    data: {
                        payment: {
                            id: result.payment.id,
                            status: result.payment.status,
                            gatewayTransactionId: result.payment.gatewayTransactionId,
                            processedAt: result.payment.processedAt
                        },
                        walletDebit: {
                            balance: result.walletDebit.balance,
                            ledgerEntryId: result.walletDebit.ledgerEntryId,
                            duplicate: result.walletDebit.duplicate
                        }
                    }
                });
            } else {
                res.status(StatusCodes.UNPROCESSABLE_ENTITY).json({
                    success: false,
                    error: 'PAYMENT_PROCESSING_FAILED',
                    message: result.error,
                    data: {
                        payment: {
                            id: result.payment.id,
                            status: result.payment.status,
                            failureReason: result.payment.failureReason
                        }
                    }
                });
            }
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /payments/:paymentId/refund
     * Refund payment (credit wallet)
     */
    async refundPayment(req, res, next) {
        try {
            const { paymentId } = req.params;
            const { walletId } = req.body;

            if (!walletId) {
                return res.status(StatusCodes.BAD_REQUEST).json({
                    success: false,
                    error: 'INVALID_INPUT',
                    message: 'walletId is required'
                });
            }

            // Get payment
            const payment = await this.paymentService.getPayment(paymentId);

            // Check if payment can be refunded
            if (payment.status !== 'COMPLETED') {
                return res.status(StatusCodes.UNPROCESSABLE_ENTITY).json({
                    success: false,
                    error: 'INVALID_PAYMENT_STATUS',
                    message: `Cannot refund payment with status ${payment.status}`
                });
            }

            // Refund payment
            const result = await this.paymentProcessor.refundPayment(payment, walletId);

            res.status(StatusCodes.OK).json({
                success: true,
                data: {
                    payment: {
                        id: result.payment.id,
                        status: result.payment.status,
                        processedAt: result.payment.processedAt
                    },
                    walletCredit: {
                        balance: result.walletCredit.balance,
                        ledgerEntryId: result.walletCredit.ledgerEntryId
                    }
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /payments/:paymentId
     * Get payment details
     */
    async getPayment(req, res, next) {
        try {
            const { paymentId } = req.params;

            const payment = await this.paymentService.getPayment(paymentId);

            res.status(StatusCodes.OK).json({
                success: true,
                data: {
                    payment: {
                        id: payment.id,
                        userId: payment.userId,
                        amount: payment.amount,
                        currency: payment.currency,
                        status: payment.status,
                        merchantId: payment.merchantId,
                        description: payment.description,
                        metadata: payment.metadata,
                        gatewayTransactionId: payment.gatewayTransactionId,
                        failureReason: payment.failureReason,
                        createdAt: payment.createdAt,
                        updatedAt: payment.updatedAt,
                        processedAt: payment.processedAt
                    }
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /payments/user/:userId
     * Get payments by user ID
     */
    async getPaymentsByUserId(req, res, next) {
        try {
            const { userId } = req.params;
            const limit = parseInt(req.query.limit) || 10;
            const offset = parseInt(req.query.offset) || 0;

            const payments = await this.paymentService.getPaymentsByUserId(userId, limit, offset);

            res.status(StatusCodes.OK).json({
                success: true,
                data: {
                    payments: payments.map(p => ({
                        id: p.id,
                        amount: p.amount,
                        currency: p.currency,
                        status: p.status,
                        merchantId: p.merchantId,
                        description: p.description,
                        createdAt: p.createdAt
                    })),
                    pagination: {
                        limit,
                        offset,
                        count: payments.length
                    }
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * PATCH /payments/:paymentId/status
     * Update payment status
     */
    async updatePaymentStatus(req, res, next) {
        try {
            const { paymentId } = req.params;
            const { status, gatewayTransactionId, failureReason } = req.body;

            if (!status) {
                return res.status(StatusCodes.BAD_REQUEST).json({
                    success: false,
                    error: 'INVALID_INPUT',
                    message: 'status is required'
                });
            }

            const payment = await this.paymentService.updatePaymentStatus(
                paymentId,
                status,
                {
                    gatewayTransactionId,
                    failureReason,
                    processedAt: new Date()
                }
            );

            res.status(StatusCodes.OK).json({
                success: true,
                data: {
                    payment: {
                        id: payment.id,
                        status: payment.status,
                        gatewayTransactionId: payment.gatewayTransactionId,
                        failureReason: payment.failureReason,
                        processedAt: payment.processedAt,
                        updatedAt: payment.updatedAt
                    }
                }
            });
        } catch (error) {
            next(error);
        }
    }

    async reconcile(req, res, next) {
        try {
            const { from, to, limit } = req.query;
            const results = await this.reconciliationService.reconcile({
                from,
                to,
                limit: limit ? parseInt(limit) : 100,
            });
            res.status(200).json({ success: true, data: results });
        } catch (error) {
            next(error);
        }
    }

    async getAnomalyStats(req, res, next) {
        try {
            const { userId } = req.params;
            const fakePayment = { id: 'check', userId, amount: 0 };
            const result = await this.anomalyDetector.check(fakePayment);
            res.status(200).json({ success: true, data: { userId, ...result } });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = PaymentController;
