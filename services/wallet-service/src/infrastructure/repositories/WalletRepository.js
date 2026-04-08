const { v4: uuidv4 } = require('uuid');
const logger = require('../../utils/logger');

/**
 * Wallet Repository - Data access layer for wallets
 */
class WalletRepository {
    constructor(databaseClient) {
        this.db = databaseClient;
    }

    /**
     * Create a new wallet
     */
    async create(wallet, client = null) {
        const executor = client || this.db;

        const query = `
      INSERT INTO wallets (
        id, user_id, currency, balance, status, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING *
    `;

        const values = [
            wallet.id || uuidv4(),
            wallet.userId,
            wallet.currency,
            wallet.balance || 0,
            wallet.status || 'ACTIVE',
            JSON.stringify(wallet.metadata || {})
        ];

        try {
            const result = await executor.query(query, values);
            logger.info('Wallet created', { walletId: result.rows[0].id, userId: wallet.userId });
            return this.mapRowToWallet(result.rows[0]);
        } catch (error) {
            if (error.code === '23505') { // Unique constraint violation
                logger.warn('Duplicate wallet creation attempt', {
                    userId: wallet.userId,
                    currency: wallet.currency
                });
                throw new Error('WALLET_ALREADY_EXISTS');
            }
            logger.error('Error creating wallet', { error: error.message, userId: wallet.userId });
            throw error;
        }
    }

    /**
     * Find wallet by ID with optional row lock
     */
    async findById(id, options = {}) {
        const { forUpdate = false, client = null } = options;
        const executor = client || this.db;

        const lockClause = forUpdate ? 'FOR UPDATE' : '';
        const query = `SELECT * FROM wallets WHERE id = $1 ${lockClause}`;

        try {
            const result = await executor.query(query, [id]);
            if (result.rows.length === 0) {
                return null;
            }
            return this.mapRowToWallet(result.rows[0]);
        } catch (error) {
            logger.error('Error finding wallet by ID', { error: error.message, id });
            throw error;
        }
    }

    /**
     * Find wallet by user ID and currency
     */
    async findByUserIdAndCurrency(userId, currency, options = {}) {
        const { forUpdate = false, client = null } = options;
        const executor = client || this.db;

        const lockClause = forUpdate ? 'FOR UPDATE' : '';
        const query = `
      SELECT * FROM wallets 
      WHERE user_id = $1 AND currency = $2 
      ${lockClause}
    `;

        try {
            const result = await executor.query(query, [userId, currency]);
            if (result.rows.length === 0) {
                return null;
            }
            return this.mapRowToWallet(result.rows[0]);
        } catch (error) {
            logger.error('Error finding wallet', {
                error: error.message,
                userId,
                currency
            });
            throw error;
        }
    }

    /**
     * Update wallet balance (with optimistic locking)
     */
    async updateBalance(walletId, newBalance, expectedVersion, client = null) {
        const executor = client || this.db;

        const query = `
      UPDATE wallets
      SET balance = $1, version = version + 1, updated_at = NOW()
      WHERE id = $2 AND version = $3
      RETURNING *
    `;

        try {
            const result = await executor.query(query, [newBalance, walletId, expectedVersion]);

            if (result.rows.length === 0) {
                throw new Error('CONCURRENT_MODIFICATION');
            }

            logger.debug('Wallet balance updated', {
                walletId,
                newBalance,
                version: result.rows[0].version
            });

            return this.mapRowToWallet(result.rows[0]);
        } catch (error) {
            logger.error('Error updating wallet balance', {
                error: error.message,
                walletId
            });
            throw error;
        }
    }

    /**
     * Get all wallets for a user
     */
    async findByUserId(userId) {
        const query = `
      SELECT * FROM wallets 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `;

        try {
            const result = await this.db.query(query, [userId]);
            return result.rows.map(row => this.mapRowToWallet(row));
        } catch (error) {
            logger.error('Error finding wallets by user ID', {
                error: error.message,
                userId
            });
            throw error;
        }
    }

    /**
     * Map database row to wallet object
     */
    mapRowToWallet(row) {
        return {
            id: row.id,
            userId: row.user_id,
            currency: row.currency,
            balance: parseInt(row.balance),
            version: row.version,
            status: row.status,
            metadata: row.metadata,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

module.exports = WalletRepository;
