const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

/**
 * Wallet Service - Business logic for wallet operations
 */
class WalletService {
    constructor(walletRepository, ledgerRepository, databaseClient) {
        this.walletRepo = walletRepository;
        this.ledgerRepo = ledgerRepository;
        this.db = databaseClient;
    }

    /**
     * Create a new wallet
     */
    async createWallet({ userId, currency, initialBalance = 0 }) {
        // Validate inputs
        if (!userId) {
            throw new Error('INVALID_INPUT: userId is required');
        }
        if (!currency) {
            throw new Error('INVALID_INPUT: currency is required');
        }
        if (initialBalance < 0) {
            throw new Error('INVALID_INPUT: initialBalance cannot be negative');
        }

        const validCurrencies = ['USD', 'EUR', 'GBP', 'INR', 'JPY'];
        if (!validCurrencies.includes(currency)) {
            throw new Error(`INVALID_INPUT: Unsupported currency ${currency}`);
        }

        try {
            // Check if wallet already exists
            const existing = await this.walletRepo.findByUserIdAndCurrency(userId, currency);
            if (existing) {
                logger.warn('Wallet already exists', { userId, currency });
                return existing;
            }

            // Create wallet
            const wallet = await this.walletRepo.create({
                userId,
                currency,
                balance: initialBalance,
                status: 'ACTIVE',
                metadata: {}
            });

            // If initial balance > 0, create ledger entry
            if (initialBalance > 0) {
                await this.ledgerRepo.create({
                    walletId: wallet.id,
                    transactionType: 'CREDIT',
                    amount: initialBalance,
                    balanceAfter: initialBalance,
                    currency,
                    referenceId: null,
                    referenceType: 'INITIAL_BALANCE',
                    idempotencyKey: `initial_${wallet.id}`,
                    description: 'Initial balance',
                    metadata: {}
                });
            }

            logger.info('Wallet created successfully', {
                walletId: wallet.id,
                userId,
                currency
            });

            return wallet;
        } catch (error) {
            logger.error('Error creating wallet', {
                error: error.message,
                userId,
                currency
            });
            throw error;
        }
    }

    /**
     * Debit wallet (withdraw money)
     * CRITICAL: Runs in transaction with row-level locking
     */
    async debitWallet({
        walletId,
        amount,
        idempotencyKey,
        referenceId,
        referenceType,
        description
    }) {
        // Validate inputs
        if (!walletId) {
            throw new Error('INVALID_INPUT: walletId is required');
        }
        if (!amount || amount <= 0) {
            throw new Error('INVALID_INPUT: amount must be greater than 0');
        }
        if (!idempotencyKey) {
            throw new Error('INVALID_INPUT: idempotencyKey is required');
        }

        logger.info('Debit wallet request', {
            walletId,
            amount,
            idempotencyKey
        });

        try {
            // Execute in transaction
            const result = await this.db.transaction(async (client) => {
                // 1. Check idempotency - has this already been processed?
                const existingEntry = await this.ledgerRepo.findByIdempotencyKey(
                    idempotencyKey,
                    client
                );

                if (existingEntry) {
                    logger.info('Duplicate debit request detected (idempotent)', {
                        idempotencyKey,
                        existingLedgerId: existingEntry.id
                    });

                    // Return the wallet state after the original transaction
                    const wallet = await this.walletRepo.findById(walletId, { client });
                    return {
                        success: true,
                        wallet,
                        ledgerEntry: existingEntry,
                        duplicate: true
                    };
                }

                // 2. Lock wallet row and get current state
                const wallet = await this.walletRepo.findById(walletId, {
                    forUpdate: true,
                    client
                });

                if (!wallet) {
                    throw new Error('WALLET_NOT_FOUND');
                }

                if (wallet.status !== 'ACTIVE') {
                    throw new Error(`WALLET_NOT_ACTIVE: Wallet status is ${wallet.status}`);
                }

                // 3. Check sufficient balance
                if (wallet.balance < amount) {
                    logger.warn('Insufficient balance', {
                        walletId,
                        balance: wallet.balance,
                        requested: amount
                    });
                    throw new Error('INSUFFICIENT_BALANCE');
                }

                // 4. Calculate new balance
                const newBalance = wallet.balance - amount;

                // 5. Update wallet balance (with optimistic locking)
                const updatedWallet = await this.walletRepo.updateBalance(
                    walletId,
                    newBalance,
                    wallet.version,
                    client
                );

                // 6. Create ledger entry (negative amount for debit)
                const ledgerEntry = await this.ledgerRepo.create({
                    walletId,
                    transactionType: 'DEBIT',
                    amount: -amount, // Negative for debit
                    balanceAfter: newBalance,
                    currency: wallet.currency,
                    referenceId,
                    referenceType,
                    idempotencyKey,
                    description: description || 'Debit transaction',
                    metadata: {}
                }, client);

                logger.info('Wallet debited successfully', {
                    walletId,
                    amount,
                    newBalance,
                    ledgerId: ledgerEntry.id
                });

                return {
                    success: true,
                    wallet: updatedWallet,
                    ledgerEntry,
                    duplicate: false
                };
            });

            return result;
        } catch (error) {
            logger.error('Error debiting wallet', {
                error: error.message,
                walletId,
                amount,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Credit wallet (add money)
     */
    async creditWallet({
        walletId,
        amount,
        idempotencyKey,
        referenceId,
        referenceType,
        description
    }) {
        // Validate inputs
        if (!walletId) {
            throw new Error('INVALID_INPUT: walletId is required');
        }
        if (!amount || amount <= 0) {
            throw new Error('INVALID_INPUT: amount must be greater than 0');
        }
        if (!idempotencyKey) {
            throw new Error('INVALID_INPUT: idempotencyKey is required');
        }

        logger.info('Credit wallet request', {
            walletId,
            amount,
            idempotencyKey
        });

        try {
            // Execute in transaction
            const result = await this.db.transaction(async (client) => {
                // 1. Check idempotency
                const existingEntry = await this.ledgerRepo.findByIdempotencyKey(
                    idempotencyKey,
                    client
                );

                if (existingEntry) {
                    logger.info('Duplicate credit request detected (idempotent)', {
                        idempotencyKey
                    });

                    const wallet = await this.walletRepo.findById(walletId, { client });
                    return {
                        success: true,
                        wallet,
                        ledgerEntry: existingEntry,
                        duplicate: true
                    };
                }

                // 2. Lock wallet row
                const wallet = await this.walletRepo.findById(walletId, {
                    forUpdate: true,
                    client
                });

                if (!wallet) {
                    throw new Error('WALLET_NOT_FOUND');
                }

                if (wallet.status !== 'ACTIVE') {
                    throw new Error(`WALLET_NOT_ACTIVE: Wallet status is ${wallet.status}`);
                }

                // 3. Calculate new balance
                const newBalance = wallet.balance + amount;

                // 4. Update wallet balance
                const updatedWallet = await this.walletRepo.updateBalance(
                    walletId,
                    newBalance,
                    wallet.version,
                    client
                );

                // 5. Create ledger entry (positive amount for credit)
                const ledgerEntry = await this.ledgerRepo.create({
                    walletId,
                    transactionType: 'CREDIT',
                    amount: amount, // Positive for credit
                    balanceAfter: newBalance,
                    currency: wallet.currency,
                    referenceId,
                    referenceType,
                    idempotencyKey,
                    description: description || 'Credit transaction',
                    metadata: {}
                }, client);

                logger.info('Wallet credited successfully', {
                    walletId,
                    amount,
                    newBalance,
                    ledgerId: ledgerEntry.id
                });

                return {
                    success: true,
                    wallet: updatedWallet,
                    ledgerEntry,
                    duplicate: false
                };
            });

            return result;
        } catch (error) {
            logger.error('Error crediting wallet', {
                error: error.message,
                walletId,
                amount
            });
            throw error;
        }
    }

    /**
     * Get wallet by ID
     */
    async getWallet(walletId) {
        if (!walletId) {
            throw new Error('INVALID_INPUT: walletId is required');
        }

        const wallet = await this.walletRepo.findById(walletId);
        if (!wallet) {
            throw new Error('WALLET_NOT_FOUND');
        }

        return wallet;
    }

    /**
     * Get wallet transaction history
     */
    async getTransactionHistory(walletId, limit = 50, offset = 0) {
        if (!walletId) {
            throw new Error('INVALID_INPUT: walletId is required');
        }

        const entries = await this.ledgerRepo.findByWalletId(walletId, limit, offset);
        return entries;
    }

    /**
     * Reconcile wallet balance with ledger
     */
    async reconcileBalance(walletId) {
        const wallet = await this.walletRepo.findById(walletId);
        if (!wallet) {
            throw new Error('WALLET_NOT_FOUND');
        }

        const ledgerBalance = await this.ledgerRepo.calculateBalance(walletId);

        const isBalanced = wallet.balance === ledgerBalance;

        logger.info('Balance reconciliation', {
            walletId,
            walletBalance: wallet.balance,
            ledgerBalance,
            isBalanced
        });

        return {
            walletId,
            walletBalance: wallet.balance,
            ledgerBalance,
            isBalanced,
            difference: wallet.balance - ledgerBalance
        };
    }
}

module.exports = WalletService;
