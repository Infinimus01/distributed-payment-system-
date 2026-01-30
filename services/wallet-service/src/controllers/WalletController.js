const logger = require('../utils/logger');
const { StatusCodes } = require('http-status-codes');

/**
 * Wallet Controller - HTTP request handlers
 */
class WalletController {
    constructor(walletService) {
        this.walletService = walletService;
    }

    /**
     * POST /wallets/create
     * Create a new wallet
     */
    async createWallet(req, res, next) {
        try {
            const { userId, currency, initialBalance } = req.body;

            // Validate required fields
            if (!userId || !currency) {
                return res.status(StatusCodes.BAD_REQUEST).json({
                    success: false,
                    error: 'INVALID_INPUT',
                    message: 'userId and currency are required'
                });
            }

            const wallet = await this.walletService.createWallet({
                userId,
                currency,
                initialBalance: initialBalance || 0
            });

            res.status(StatusCodes.CREATED).json({
                success: true,
                data: {
                    wallet: {
                        id: wallet.id,
                        userId: wallet.userId,
                        currency: wallet.currency,
                        balance: wallet.balance,
                        status: wallet.status,
                        createdAt: wallet.createdAt
                    }
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /wallets/debit
     * Debit money from wallet
     */
    async debitWallet(req, res, next) {
        try {
            const {
                walletId,
                amount,
                idempotencyKey,
                referenceId,
                referenceType,
                description
            } = req.body;

            // Validate required fields
            if (!walletId || !amount || !idempotencyKey) {
                return res.status(StatusCodes.BAD_REQUEST).json({
                    success: false,
                    error: 'INVALID_INPUT',
                    message: 'walletId, amount, and idempotencyKey are required'
                });
            }

            const result = await this.walletService.debitWallet({
                walletId,
                amount,
                idempotencyKey,
                referenceId,
                referenceType,
                description
            });

            res.status(StatusCodes.OK).json({
                success: true,
                data: {
                    wallet: {
                        id: result.wallet.id,
                        balance: result.wallet.balance,
                        version: result.wallet.version
                    },
                    ledgerEntry: {
                        id: result.ledgerEntry.id,
                        amount: result.ledgerEntry.amount,
                        balanceAfter: result.ledgerEntry.balanceAfter,
                        createdAt: result.ledgerEntry.createdAt
                    },
                    duplicate: result.duplicate
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /wallets/credit
     * Credit money to wallet
     */
    async creditWallet(req, res, next) {
        try {
            const {
                walletId,
                amount,
                idempotencyKey,
                referenceId,
                referenceType,
                description
            } = req.body;

            // Validate required fields
            if (!walletId || !amount || !idempotencyKey) {
                return res.status(StatusCodes.BAD_REQUEST).json({
                    success: false,
                    error: 'INVALID_INPUT',
                    message: 'walletId, amount, and idempotencyKey are required'
                });
            }

            const result = await this.walletService.creditWallet({
                walletId,
                amount,
                idempotencyKey,
                referenceId,
                referenceType,
                description
            });

            res.status(StatusCodes.OK).json({
                success: true,
                data: {
                    wallet: {
                        id: result.wallet.id,
                        balance: result.wallet.balance,
                        version: result.wallet.version
                    },
                    ledgerEntry: {
                        id: result.ledgerEntry.id,
                        amount: result.ledgerEntry.amount,
                        balanceAfter: result.ledgerEntry.balanceAfter,
                        createdAt: result.ledgerEntry.createdAt
                    },
                    duplicate: result.duplicate
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /wallets/:walletId
     * Get wallet details
     */
    async getWallet(req, res, next) {
        try {
            const { walletId } = req.params;

            const wallet = await this.walletService.getWallet(walletId);

            res.status(StatusCodes.OK).json({
                success: true,
                data: {
                    wallet: {
                        id: wallet.id,
                        userId: wallet.userId,
                        currency: wallet.currency,
                        balance: wallet.balance,
                        status: wallet.status,
                        version: wallet.version,
                        createdAt: wallet.createdAt,
                        updatedAt: wallet.updatedAt
                    }
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /wallets/:walletId/transactions
     * Get wallet transaction history
     */
    async getTransactionHistory(req, res, next) {
        try {
            const { walletId } = req.params;
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;

            const transactions = await this.walletService.getTransactionHistory(
                walletId,
                limit,
                offset
            );

            res.status(StatusCodes.OK).json({
                success: true,
                data: {
                    transactions,
                    pagination: {
                        limit,
                        offset,
                        count: transactions.length
                    }
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /wallets/:walletId/reconcile
     * Reconcile wallet balance with ledger
     */
    async reconcileBalance(req, res, next) {
        try {
            const { walletId } = req.params;

            const reconciliation = await this.walletService.reconcileBalance(walletId);

            res.status(StatusCodes.OK).json({
                success: true,
                data: reconciliation
            });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = WalletController;
