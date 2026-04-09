const axios = require('axios');
const logger = require('../../utils/logger');

/**
 * Wallet Client - HTTP client for Wallet Service
 * 
 * Implements exactly-once semantics through idempotency keys
 */
class WalletClient {
    constructor(baseUrl, timeout = 10000) {
        this.baseUrl = baseUrl;
        this.timeout = timeout;
        this.client = axios.create({
            baseURL: baseUrl,
            timeout: timeout,
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // Add request interceptor for logging
        this.client.interceptors.request.use(
            (config) => {
                logger.debug('Wallet service request', {
                    method: config.method,
                    url: config.url,
                    data: config.data
                });
                return config;
            },
            (error) => {
                logger.error('Wallet service request error', { error: error.message });
                return Promise.reject(error);
            }
        );

        // Add response interceptor for logging
        this.client.interceptors.response.use(
            (response) => {
                logger.debug('Wallet service response', {
                    status: response.status,
                    data: response.data
                });
                return response;
            },
            (error) => {
                logger.error('Wallet service response error', {
                    status: error.response?.status,
                    data: error.response?.data,
                    message: error.message
                });
                return Promise.reject(error);
            }
        );
    }

    /**
     * Debit wallet
     * 
     * IDEMPOTENCY GUARANTEE:
     * - Uses payment ID as idempotency key
     * - Wallet service ensures same idempotency key → same result
     * - Safe to retry on network failures
     * - No duplicate ledger entries
     * 
     * @param {Object} params
     * @param {string} params.walletId - Wallet ID to debit
     * @param {number} params.amount - Amount to debit (in cents)
     * @param {string} params.paymentId - Payment ID (used as idempotency key)
     * @param {string} params.description - Transaction description
     * @returns {Promise<Object>} Debit result
     */
    async debitWallet({ walletId, amount, paymentId, description }) {
        try {
            logger.info('Debiting wallet', { walletId, amount, paymentId });

            const response = await this.client.post('/wallets/debit', {
                walletId,
                amount,
                idempotencyKey: `payment_${paymentId}`, // CRITICAL: Ensures exactly-once
                referenceId: paymentId,
                referenceType: 'PAYMENT',
                description: description || `Payment ${paymentId}`
            });

            logger.info('Wallet debited successfully', {
                walletId,
                amount,
                paymentId,
                duplicate: response.data.data.duplicate
            });

            return {
                success: true,
                balance: response.data.data.wallet.balance,
                ledgerEntryId: response.data.data.ledgerEntry.id,
                duplicate: response.data.data.duplicate
            };
        } catch (error) {
            // Handle specific wallet errors
            if (error.response) {
                const errorCode = error.response.data?.error;
                const errorMessage = error.response.data?.message;

                logger.error('Wallet debit failed', {
                    walletId,
                    amount,
                    paymentId,
                    errorCode,
                    errorMessage,
                    status: error.response.status
                });

                // Map wallet errors to payment errors
                if (errorCode === 'INSUFFICIENT_BALANCE') {
                    throw new Error('WALLET_INSUFFICIENT_BALANCE');
                } else if (errorCode === 'WALLET_NOT_FOUND') {
                    throw new Error('WALLET_NOT_FOUND');
                } else if (errorCode === 'WALLET_NOT_ACTIVE') {
                    throw new Error('WALLET_NOT_ACTIVE');
                } else {
                    throw new Error(`WALLET_ERROR: ${errorMessage}`);
                }
            }

            // Network or timeout error - safe to retry
            logger.error('Wallet service network error', {
                walletId,
                amount,
                paymentId,
                error: error.message
            });
            throw new Error('WALLET_SERVICE_UNAVAILABLE');
        }
    }

    /**
     * Credit wallet (for refunds)
     */
    async creditWallet({ walletId, amount, paymentId, description }) {
        try {
            logger.info('Crediting wallet', { walletId, amount, paymentId });

            const response = await this.client.post('/wallets/credit', {
                walletId,
                amount,
                idempotencyKey: `refund_${paymentId}`,
                referenceId: paymentId,
                referenceType: 'REFUND',
                description: description || `Refund for payment ${paymentId}`
            });

            logger.info('Wallet credited successfully', {
                walletId,
                amount,
                paymentId
            });

            return {
                success: true,
                balance: response.data.data.wallet.balance,
                ledgerEntryId: response.data.data.ledgerEntry.id
            };
        } catch (error) {
            logger.error('Wallet credit failed', {
                walletId,
                amount,
                paymentId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get wallet details
     */
    async getWallet(walletId) {
        try {
            const response = await this.client.get(`/wallets/${walletId}`);
            return response.data.data.wallet;
        } catch (error) {
            logger.error('Failed to get wallet', { walletId, error: error.message });
            throw error;
        }
    }


    /**
     * Verify ledger entry exists — used by ReconciliationService
     * Returns true if entry exists, false if not found
     */
    async verifyLedgerEntry(walletId, ledgerEntryId) {
        try {
            const response = await this.client.get(
                `/wallets/${walletId}/ledger/${ledgerEntryId}`
            );
            return response.data.data?.exists === true;
        } catch (error) {
            if (error.response?.status === 404) return false;
            throw new Error('WALLET_SERVICE_UNAVAILABLE');
        }
    }

    /**
     * Health check
     */
    async healthCheck() {
        try {
            const response = await this.client.get('/health');
            return response.data.status === 'healthy';
        } catch (error) {
            logger.error('Wallet service health check failed', { error: error.message });
            return false;
        }
    }
}

module.exports = WalletClient;
