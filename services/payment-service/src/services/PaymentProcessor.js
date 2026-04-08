const logger = require('../utils/logger');
const { registry } = require('../../shared/resilience/CircuitBreaker');
const { withSmartRetry } = require('../../shared/resilience/SmartRetry');

/**
 * PaymentProcessor v2 — Circuit Breaker + Smart Retry
 *
 * Improvements over v1:
 * 1. Circuit Breaker: If wallet service is down, stop hammering it.
 *    Fast-fail after 5 failures, recover after 30s.
 * 2. Smart Retry: Classify errors before retrying.
 *    Network error = retry. Insufficient funds = never retry.
 * 3. Jitter on backoff: Prevents thundering herd on recovery.
 * 4. Stats endpoint: /health shows circuit state in real time.
 */
class PaymentProcessor {
  constructor(paymentService, walletClient, config) {
    this.paymentService = paymentService;
    this.walletClient = walletClient;
    this.config = config;

    // Circuit breaker for wallet service calls
    // Opens after 5 failures, recovers after 30s
    this.walletCircuitBreaker = registry.get('wallet-service', {
      failureThreshold:  config.circuitBreaker?.failureThreshold  ?? 5,
      recoveryTimeout:   config.circuitBreaker?.recoveryTimeout   ?? 30000,
      successThreshold:  config.circuitBreaker?.successThreshold  ?? 2,
      timeout:           config.circuitBreaker?.timeout           ?? 10000,
    });
  }

  /**
   * Process payment with wallet debit
   *
   * FLOW:
   * 1. PENDING → PROCESSING
   * 2. Debit wallet (circuit breaker + smart retry)
   * 3. PROCESSING → COMPLETED or FAILED
   */
  async processPayment(payment, walletId) {
    logger.info('Processing payment', {
      paymentId: payment.id,
      userId: payment.userId,
      amount: payment.amount,
      walletId,
      circuitState: this.walletCircuitBreaker.getState(),
    });

    try {
      await this.paymentService.updatePaymentStatus(payment.id, 'PROCESSING');

      const debitResult = await this._debitWithProtection({
        walletId,
        amount: payment.amount,
        paymentId: payment.id,
        description: payment.description,
      });

      const completedPayment = await this.paymentService.updatePaymentStatus(
        payment.id,
        'COMPLETED',
        {
          gatewayTransactionId: debitResult.ledgerEntryId,
          processedAt: new Date(),
        }
      );

      logger.info('Payment processed successfully', {
        paymentId: payment.id,
        ledgerEntryId: debitResult.ledgerEntryId,
        duplicate: debitResult.duplicate,
      });

      return { success: true, payment: completedPayment, walletDebit: debitResult };

    } catch (error) {
      logger.error('Payment processing failed', {
        paymentId: payment.id,
        error: error.message,
        circuitState: this.walletCircuitBreaker.getState(),
      });

      await this.paymentService.updatePaymentStatus(payment.id, 'FAILED', {
        failureReason: error.message,
        processedAt: new Date(),
      });

      return {
        success: false,
        payment: await this.paymentService.getPayment(payment.id),
        error: error.message,
      };
    }
  }

  /**
   * Debit wallet with circuit breaker wrapping smart retry
   *
   * Circuit Breaker (outer): Stops calls when wallet is down
   * Smart Retry (inner):     Retries transient failures intelligently
   *
   * Order matters:
   * Circuit breaker is OUTSIDE retry — if circuit is open,
   * we don't even attempt the retry loop.
   */
  async _debitWithProtection(params) {
    return this.walletCircuitBreaker.execute(() =>
      withSmartRetry(
        () => this.walletClient.debitWallet(params),
        {
          maxAttempts: this.config.payment?.maxRetryAttempts ?? 3,
          baseDelayMs: this.config.payment?.retryDelayMs     ?? 500,
          maxDelayMs:  10000,
          jitter:      true,
          context:     `wallet-debit:${params.paymentId}`,
        }
      )
    );
  }

  /**
   * Refund payment — circuit breaker protected
   */
  async refundPayment(payment, walletId) {
    logger.info('Refunding payment', {
      paymentId: payment.id,
      amount: payment.amount,
      walletId,
    });

    try {
      const creditResult = await this.walletCircuitBreaker.execute(() =>
        this.walletClient.creditWallet({
          walletId,
          amount: payment.amount,
          paymentId: payment.id,
          description: `Refund for ${payment.description}`,
        })
      );

      const refundedPayment = await this.paymentService.updatePaymentStatus(
        payment.id,
        'REFUNDED',
        { processedAt: new Date() }
      );

      logger.info('Payment refunded successfully', {
        paymentId: payment.id,
        ledgerEntryId: creditResult.ledgerEntryId,
      });

      return { success: true, payment: refundedPayment, walletCredit: creditResult };

    } catch (error) {
      logger.error('Payment refund failed', {
        paymentId: payment.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Circuit breaker stats — expose via /health endpoint
   */
  getCircuitBreakerStats() {
    return this.walletCircuitBreaker.getStats();
  }
}

module.exports = PaymentProcessor;
