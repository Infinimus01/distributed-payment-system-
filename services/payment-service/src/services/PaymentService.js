const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

/**
 * Payment Service - Business logic for payment operations
 */
class PaymentService {
    constructor(paymentRepository, idempotencyService, eventPublisher, databaseClient) {
        this.paymentRepo = paymentRepository;
        this.idempotencyService = idempotencyService;
        this.eventPublisher = eventPublisher;
        this.db = databaseClient;
    }

    /**
     * Create a new payment with idempotency
     */
    async createPayment({
        userId,
        amount,
        currency,
        merchantId,
        description,
        metadata,
        idempotencyKey
    }) {
        // Validate inputs
        if (!userId) {
            throw new Error('INVALID_INPUT: userId is required');
        }
        if (!amount || amount <= 0) {
            throw new Error('INVALID_INPUT: amount must be greater than 0');
        }
        if (!currency) {
            throw new Error('INVALID_INPUT: currency is required');
        }
        if (!merchantId) {
            throw new Error('INVALID_INPUT: merchantId is required');
        }
        if (!idempotencyKey) {
            throw new Error('INVALID_INPUT: idempotencyKey is required');
        }

        const validCurrencies = ['USD', 'EUR', 'GBP', 'INR', 'JPY'];
        if (!validCurrencies.includes(currency)) {
            throw new Error(`INVALID_INPUT: Unsupported currency ${currency}`);
        }

        logger.info('Create payment request', {
            userId,
            amount,
            currency,
            merchantId,
            idempotencyKey
        });

        try {
            // Step 1: Check Redis cache for idempotency
            const cachedPayment = await this.idempotencyService.getPayment(idempotencyKey);
            if (cachedPayment) {
                logger.info('Returning cached payment (idempotent)', {
                    paymentId: cachedPayment.id,
                    idempotencyKey
                });
                return {
                    payment: cachedPayment,
                    duplicate: true,
                    source: 'cache'
                };
            }

            // Step 2: Check database for idempotency (in case Redis cache expired)
            const existingPayment = await this.paymentRepo.findByIdempotencyKey(idempotencyKey);
            if (existingPayment) {
                logger.info('Returning existing payment from DB (idempotent)', {
                    paymentId: existingPayment.id,
                    idempotencyKey
                });

                // Re-cache in Redis
                await this.idempotencyService.storePayment(idempotencyKey, existingPayment);

                return {
                    payment: existingPayment,
                    duplicate: true,
                    source: 'database'
                };
            }

            // Step 3: Create new payment in database
            const payment = await this.paymentRepo.create({
                id: uuidv4(),
                userId,
                amount,
                currency,
                status: 'PENDING',
                idempotencyKey,
                merchantId,
                description: description || `Payment to ${merchantId}`,
                metadata: metadata || {}
            });

            logger.info('Payment created successfully', {
                paymentId: payment.id,
                userId,
                amount,
                status: payment.status
            });

            // Step 4: Store in Redis cache for future idempotency checks
            await this.idempotencyService.storePayment(idempotencyKey, payment);

            // Step 5: Publish PaymentCreated event
            await this.eventPublisher.publishPaymentCreated(payment);

            return {
                payment,
                duplicate: false,
                source: 'created'
            };
        } catch (error) {
            // Handle duplicate payment error from database
            if (error.message === 'DUPLICATE_PAYMENT') {
                // Race condition: payment was created between cache check and DB insert
                logger.warn('Race condition detected, fetching existing payment', {
                    idempotencyKey
                });

                const existingPayment = await this.paymentRepo.findByIdempotencyKey(idempotencyKey);
                if (existingPayment) {
                    await this.idempotencyService.storePayment(idempotencyKey, existingPayment);
                    return {
                        payment: existingPayment,
                        duplicate: true,
                        source: 'race_condition'
                    };
                }
            }

            logger.error('Error creating payment', {
                error: error.message,
                userId,
                amount,
                idempotencyKey,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Get payment by ID
     */
    async getPayment(paymentId) {
        if (!paymentId) {
            throw new Error('INVALID_INPUT: paymentId is required');
        }

        const payment = await this.paymentRepo.findById(paymentId);
        if (!payment) {
            throw new Error('PAYMENT_NOT_FOUND');
        }

        return payment;
    }

    /**
     * Get payments by user ID
     */
    async getPaymentsByUserId(userId, limit = 10, offset = 0) {
        if (!userId) {
            throw new Error('INVALID_INPUT: userId is required');
        }

        const payments = await this.paymentRepo.findByUserId(userId, limit, offset);
        return payments;
    }

    /**
     * Update payment status
     */
    async updatePaymentStatus(paymentId, newStatus, additionalFields = {}) {
        if (!paymentId) {
            throw new Error('INVALID_INPUT: paymentId is required');
        }
        if (!newStatus) {
            throw new Error('INVALID_INPUT: newStatus is required');
        }

        const validStatuses = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED'];
        if (!validStatuses.includes(newStatus)) {
            throw new Error(`INVALID_INPUT: Invalid status ${newStatus}`);
        }

        logger.info('Updating payment status', {
            paymentId,
            newStatus
        });

        try {
            // Get current payment
            const currentPayment = await this.paymentRepo.findById(paymentId);
            if (!currentPayment) {
                throw new Error('PAYMENT_NOT_FOUND');
            }

            const previousStatus = currentPayment.status;

            // Update status
            const updatedPayment = await this.paymentRepo.updateStatus(
                paymentId,
                newStatus,
                additionalFields
            );

            logger.info('Payment status updated', {
                paymentId,
                previousStatus,
                newStatus
            });

            // Publish status change event
            await this.eventPublisher.publishPaymentStatusChanged(updatedPayment, previousStatus);

            // Update Redis cache if it exists
            if (currentPayment.idempotencyKey) {
                await this.idempotencyService.storePayment(
                    currentPayment.idempotencyKey,
                    updatedPayment
                );
            }

            return updatedPayment;
        } catch (error) {
            logger.error('Error updating payment status', {
                error: error.message,
                paymentId,
                newStatus,
                stack: error.stack
            });
            throw error;
        }
    }
}

module.exports = PaymentService;
