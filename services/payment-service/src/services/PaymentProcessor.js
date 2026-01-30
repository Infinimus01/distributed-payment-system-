const logger = require('../utils/logger');

/**
 * Payment Processor - Orchestrates payment processing with wallet debit
 * 
 * RETRY STRATEGY:
 * ===============
 * 
 * 1. IDEMPOTENCY-BASED RETRIES:
 *    - Each wallet debit uses payment ID as idempotency key
 *    - Same payment ID → same ledger entry (no duplicates)
 *    - Safe to retry indefinitely on network failures
 * 
 * 2. RETRY SCENARIOS:
 *    a) Network Timeout → RETRY (idempotent)
 *    b) Wallet Service Down → RETRY (idempotent)
 *    c) Insufficient Balance → FAIL (don't retry)
 *    d) Wallet Not Found → FAIL (don't retry)
 * 
 * 3. EXPONENTIAL BACKOFF:
 *    - Attempt 1: Immediate
 *    - Attempt 2: 1 second delay
 *    - Attempt 3: 2 seconds delay
 *    - Max attempts: 3
 * 
 * 4. EXACTLY-ONCE GUARANTEE:
 *    - Payment status transitions tracked in DB
 *    - Wallet debit idempotency prevents double charge
 *    - Even if retry succeeds after timeout, only one ledger entry created
 * 
 * FAILURE HANDLING:
 * =================
 * 
 * - Payment status updated to FAILED with reason
 * - Original payment remains in DB for audit
 * - Client can retry entire payment with new idempotency key
 * - Failed wallet debit does NOT create ledger entry
 */
class PaymentProcessor {
    constructor(paymentService, walletClient, config) {
        this.paymentService = paymentService;
        this.walletClient = walletClient;
        this.maxRetries = config.payment.maxRetryAttempts || 3;
        this.retryDelay = config.payment.retryDelayMs || 1000;
    }

    /**
     * Process payment with wallet debit
     * 
     * FLOW:
     * 1. Payment created (status: PENDING)
     * 2. Update status to PROCESSING
     * 3. Debit wallet (with retries)
     * 4. Update status to COMPLETED or FAILED
     */
    async processPayment(payment, walletId) {
        logger.info('Processing payment', {
            paymentId: payment.id,
            userId: payment.userId,
            amount: payment.amount,
            walletId
        });

        try {
            // Step 1: Update payment status to PROCESSING
            await this.paymentService.updatePaymentStatus(payment.id, 'PROCESSING');

            // Step 2: Debit wallet with retry logic
            const debitResult = await this.debitWalletWithRetry({
                walletId,
                amount: payment.amount,
                paymentId: payment.id,
                description: payment.description
            });

            // Step 3: Update payment status to COMPLETED
            const completedPayment = await this.paymentService.updatePaymentStatus(
                payment.id,
                'COMPLETED',
                {
                    gatewayTransactionId: debitResult.ledgerEntryId,
                    processedAt: new Date()
                }
            );

            logger.info('Payment processed successfully', {
                paymentId: payment.id,
                ledgerEntryId: debitResult.ledgerEntryId,
                duplicate: debitResult.duplicate
            });

            return {
                success: true,
                payment: completedPayment,
                walletDebit: debitResult
            };
        } catch (error) {
            // Handle failure - update payment status to FAILED
            logger.error('Payment processing failed', {
                paymentId: payment.id,
                error: error.message,
                stack: error.stack
            });

            await this.paymentService.updatePaymentStatus(
                payment.id,
                'FAILED',
                {
                    failureReason: error.message,
                    processedAt: new Date()
                }
            );

            return {
                success: false,
                payment: await this.paymentService.getPayment(payment.id),
                error: error.message
            };
        }
    }

    /**
     * Debit wallet with exponential backoff retry
     * 
     * RETRY LOGIC:
     * - Retries on network errors (WALLET_SERVICE_UNAVAILABLE)
     * - Does NOT retry on business errors (INSUFFICIENT_BALANCE, etc.)
     * - Uses exponential backoff: 0ms, 1000ms, 2000ms
     * - Idempotency key ensures no duplicate charges
     */
    async debitWalletWithRetry(params) {
        let lastError;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                logger.info('Wallet debit attempt', {
                    attempt,
                    maxRetries: this.maxRetries,
                    paymentId: params.paymentId
                });

                // Attempt wallet debit
                const result = await this.walletClient.debitWallet(params);

                // Success - log if this was a retry
                if (attempt > 1) {
                    logger.info('Wallet debit succeeded after retry', {
                        attempt,
                        paymentId: params.paymentId,
                        duplicate: result.duplicate
                    });
                }

                return result;
            } catch (error) {
                lastError = error;

                // Check if error is retryable
                const isRetryable = this.isRetryableError(error);

                logger.warn('Wallet debit attempt failed', {
                    attempt,
                    maxRetries: this.maxRetries,
                    paymentId: params.paymentId,
                    error: error.message,
                    retryable: isRetryable
                });

                // Don't retry business errors
                if (!isRetryable) {
                    logger.error('Non-retryable error, failing immediately', {
                        paymentId: params.paymentId,
                        error: error.message
                    });
                    throw error;
                }

                // Don't retry if this was the last attempt
                if (attempt === this.maxRetries) {
                    logger.error('Max retries exhausted', {
                        paymentId: params.paymentId,
                        attempts: attempt
                    });
                    throw error;
                }

                // Calculate backoff delay: attempt 1 → 0ms, attempt 2 → 1000ms, attempt 3 → 2000ms
                const delay = (attempt - 1) * this.retryDelay;

                if (delay > 0) {
                    logger.info('Retrying after delay', {
                        paymentId: params.paymentId,
                        delayMs: delay,
                        nextAttempt: attempt + 1
                    });
                    await this.sleep(delay);
                }
            }
        }

        // Should never reach here, but just in case
        throw lastError;
    }

    /**
     * Determine if error is retryable
     * 
     * RETRYABLE:
     * - WALLET_SERVICE_UNAVAILABLE (network/timeout)
     * 
     * NON-RETRYABLE (business errors):
     * - WALLET_INSUFFICIENT_BALANCE
     * - WALLET_NOT_FOUND
     * - WALLET_NOT_ACTIVE
     * - WALLET_ERROR
     */
    isRetryableError(error) {
        const retryableErrors = [
            'WALLET_SERVICE_UNAVAILABLE'
        ];

        return retryableErrors.includes(error.message);
    }

    /**
     * Sleep utility for retry delays
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Refund payment (credit wallet)
     */
    async refundPayment(payment, walletId) {
        logger.info('Refunding payment', {
            paymentId: payment.id,
            amount: payment.amount,
            walletId
        });

        try {
            // Credit wallet
            const creditResult = await this.walletClient.creditWallet({
                walletId,
                amount: payment.amount,
                paymentId: payment.id,
                description: `Refund for ${payment.description}`
            });

            // Update payment status to REFUNDED
            const refundedPayment = await this.paymentService.updatePaymentStatus(
                payment.id,
                'REFUNDED',
                {
                    processedAt: new Date()
                }
            );

            logger.info('Payment refunded successfully', {
                paymentId: payment.id,
                ledgerEntryId: creditResult.ledgerEntryId
            });

            return {
                success: true,
                payment: refundedPayment,
                walletCredit: creditResult
            };
        } catch (error) {
            logger.error('Payment refund failed', {
                paymentId: payment.id,
                error: error.message
            });
            throw error;
        }
    }
}

module.exports = PaymentProcessor;
