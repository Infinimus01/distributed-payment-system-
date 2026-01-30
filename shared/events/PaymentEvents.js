/**
 * Payment Event Types
 * Used for inter-service communication
 */

const PaymentEventTypes = {
    // Payment lifecycle events
    PAYMENT_CREATED: 'payment.created',
    PAYMENT_PROCESSING: 'payment.processing',
    PAYMENT_COMPLETED: 'payment.completed',
    PAYMENT_FAILED: 'payment.failed',
    PAYMENT_REFUNDED: 'payment.refunded',
    PAYMENT_CANCELLED: 'payment.cancelled',

    // Wallet events
    WALLET_DEBITED: 'wallet.debited',
    WALLET_CREDITED: 'wallet.credited',
    WALLET_CREATED: 'wallet.created',

    // System events
    IDEMPOTENCY_CHECK: 'system.idempotency_check',
    LOCK_ACQUIRED: 'system.lock_acquired',
    LOCK_RELEASED: 'system.lock_released'
};

module.exports = { PaymentEventTypes };
