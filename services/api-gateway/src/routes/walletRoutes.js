const logger = require('../utils/logger');

/**
 * Wallet Routes - Proxy to Wallet Service
 */
class WalletRoutes {
    constructor(serviceProxy) {
        this.serviceProxy = serviceProxy;
    }

    /**
     * POST /api/wallets/create
     * Create a new wallet
     */
    async createWallet(req, res, next) {
        try {
            const result = await this.serviceProxy.forwardToWalletService(
                'POST',
                '/wallets/create',
                req.body
            );
            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/wallets/:walletId
     * Get wallet details
     */
    async getWallet(req, res, next) {
        try {
            const { walletId } = req.params;
            const result = await this.serviceProxy.forwardToWalletService(
                'GET',
                `/wallets/${walletId}`
            );
            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/wallets/:walletId/transactions
     * Get transaction history
     */
    async getTransactionHistory(req, res, next) {
        try {
            const { walletId } = req.params;
            const { limit, offset } = req.query;
            const queryString = new URLSearchParams({ limit, offset }).toString();
            const path = `/wallets/${walletId}/transactions${queryString ? '?' + queryString : ''}`;

            const result = await this.serviceProxy.forwardToWalletService('GET', path);
            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/wallets/:walletId/reconcile
     * Reconcile wallet balance
     */
    async reconcileBalance(req, res, next) {
        try {
            const { walletId } = req.params;
            const result = await this.serviceProxy.forwardToWalletService(
                'GET',
                `/wallets/${walletId}/reconcile`
            );
            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/wallets/debit
     * Debit wallet
     */
    async debitWallet(req, res, next) {
        try {
            const result = await this.serviceProxy.forwardToWalletService(
                'POST',
                '/wallets/debit',
                req.body
            );
            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/wallets/credit
     * Credit wallet
     */
    async creditWallet(req, res, next) {
        try {
            const result = await this.serviceProxy.forwardToWalletService(
                'POST',
                '/wallets/credit',
                req.body
            );
            res.status(result.status).json(result.data);
        } catch (error) {
            next(error);
        }
    }
}

module.exports = WalletRoutes;
