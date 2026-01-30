/**
 * Payment Status Enum
 */
const PaymentStatus = {
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    REFUNDED: 'REFUNDED',
    CANCELLED: 'CANCELLED'
};

/**
 * Transaction Type Enum
 */
const TransactionType = {
    DEBIT: 'DEBIT',
    CREDIT: 'CREDIT',
    REFUND: 'REFUND'
};

/**
 * Currency Enum
 */
const Currency = {
    USD: 'USD',
    EUR: 'EUR',
    GBP: 'GBP',
    INR: 'INR',
    JPY: 'JPY'
};

module.exports = {
    PaymentStatus,
    TransactionType,
    Currency
};
