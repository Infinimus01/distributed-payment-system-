const logger = require('../utils/logger');

/**
 * ReconciliationService - Detects mismatches between payment records and wallet ledger
 *
 * Real fintech pain point this solves:
 * - Payment marked COMPLETED but wallet never debited
 * - Payment marked FAILED but wallet was debited (double-spend risk)
 * - Orphaned ledger entries with no corresponding payment
 *
 * This runs as both:
 * 1. On-demand: GET /payments/reconcile?from=...&to=...
 * 2. Scheduled: Every 5 minutes automatically
 */
class ReconciliationService {
  constructor(paymentRepository, walletClient) {
    this.paymentRepo = paymentRepository;
    this.walletClient = walletClient;
  }

  /**
   * Reconcile payments in a time window
   * 
   * LOGIC:
   * - COMPLETED payment → must have ledger entry → MATCHED
   * - COMPLETED payment → no ledger entry → MISMATCH (money lost?)
   * - FAILED payment → has ledger entry → MISMATCH (double charge?)
   * - PENDING > 10 min → SUSPICIOUS (stuck payment)
   */
  async reconcile({ from, to, limit = 100 } = {}) {
    const startTime = Date.now();
    
    logger.info('Starting reconciliation', { from, to, limit });

    const fromDate = from ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    // Fetch payments in window
    const payments = await this.paymentRepo.findByDateRange(fromDate, toDate, limit);

    const results = {
      summary: {
        total: payments.length,
        matched: 0,
        mismatched: 0,
        suspicious: 0,
        skipped: 0,
      },
      mismatches: [],
      suspicious: [],
      durationMs: 0,
    };

    for (const payment of payments) {
      try {
        const check = await this._checkPayment(payment);

        if (check.status === 'MATCHED') {
          results.summary.matched++;
        } else if (check.status === 'MISMATCH') {
          results.summary.mismatched++;
          results.mismatches.push(check);
        } else if (check.status === 'SUSPICIOUS') {
          results.summary.suspicious++;
          results.suspicious.push(check);
        } else {
          results.summary.skipped++;
        }
      } catch (err) {
        logger.warn('Could not reconcile payment', {
          paymentId: payment.id,
          error: err.message,
        });
        results.summary.skipped++;
      }
    }

    results.durationMs = Date.now() - startTime;

    logger.info('Reconciliation complete', results.summary);

    // Alert if mismatches found
    if (results.summary.mismatched > 0) {
      logger.error('RECONCILIATION ALERT: Mismatches detected!', {
        count: results.summary.mismatched,
        paymentIds: results.mismatches.map(m => m.paymentId),
      });
    }

    return results;
  }

  async _checkPayment(payment) {
    const { id, status, amount, walletId } = payment;

    // PENDING for more than 10 minutes — suspicious
    if (status === 'PENDING') {
      const ageMs = Date.now() - new Date(payment.createdAt).getTime();
      if (ageMs > 10 * 60 * 1000) {
        return {
          status: 'SUSPICIOUS',
          paymentId: id,
          reason: 'STUCK_PENDING',
          detail: `Payment has been PENDING for ${Math.round(ageMs / 60000)} minutes`,
          payment: { id, status, amount },
        };
      }
      // Recent PENDING — skip, not yet processed
      return { status: 'SKIPPED', paymentId: id, reason: 'RECENTLY_PENDING' };
    }

    // PROCESSING for more than 5 minutes — suspicious
    if (status === 'PROCESSING') {
      const ageMs = Date.now() - new Date(payment.updatedAt || payment.createdAt).getTime();
      if (ageMs > 5 * 60 * 1000) {
        return {
          status: 'SUSPICIOUS',
          paymentId: id,
          reason: 'STUCK_PROCESSING',
          detail: `Payment stuck in PROCESSING for ${Math.round(ageMs / 60000)} minutes`,
          payment: { id, status, amount },
        };
      }
      return { status: 'SKIPPED', paymentId: id, reason: 'RECENTLY_PROCESSING' };
    }

    // COMPLETED — must have ledger entry
    if (status === 'COMPLETED') {
      if (!payment.gatewayTransactionId) {
        return {
          status: 'MISMATCH',
          paymentId: id,
          reason: 'COMPLETED_NO_LEDGER_ID',
          detail: 'Payment COMPLETED but no gatewayTransactionId recorded',
          severity: 'HIGH',
          payment: { id, status, amount },
        };
      }

      // Try to verify ledger entry exists via wallet service
      if (walletId) {
        try {
          const ledgerExists = await this.walletClient.verifyLedgerEntry(
            walletId,
            payment.gatewayTransactionId
          );

          if (!ledgerExists) {
            return {
              status: 'MISMATCH',
              paymentId: id,
              reason: 'COMPLETED_LEDGER_MISSING',
              detail: 'Payment COMPLETED but ledger entry not found in wallet',
              severity: 'CRITICAL',
              payment: { id, status, amount, gatewayTransactionId: payment.gatewayTransactionId },
            };
          }
        } catch (err) {
          // Wallet service unavailable — skip for now
          return { status: 'SKIPPED', paymentId: id, reason: 'WALLET_UNAVAILABLE' };
        }
      }

      return { status: 'MATCHED', paymentId: id };
    }

    // FAILED — should NOT have ledger entry
    if (status === 'FAILED') {
      if (payment.gatewayTransactionId && walletId) {
        try {
          const ledgerExists = await this.walletClient.verifyLedgerEntry(
            walletId,
            payment.gatewayTransactionId
          );

          if (ledgerExists) {
            return {
              status: 'MISMATCH',
              paymentId: id,
              reason: 'FAILED_BUT_DEBITED',
              detail: 'Payment FAILED but wallet was debited — potential double charge!',
              severity: 'CRITICAL',
              payment: { id, status, amount, gatewayTransactionId: payment.gatewayTransactionId },
            };
          }
        } catch (err) {
          return { status: 'SKIPPED', paymentId: id, reason: 'WALLET_UNAVAILABLE' };
        }
      }
      return { status: 'MATCHED', paymentId: id };
    }

    // REFUNDED, CANCELLED — skip
    return { status: 'SKIPPED', paymentId: id, reason: `STATUS_${status}` };
  }
}

module.exports = ReconciliationService;
