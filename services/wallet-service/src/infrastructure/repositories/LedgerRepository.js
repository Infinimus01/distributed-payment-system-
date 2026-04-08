const { v4: uuidv4 } = require('uuid');
const logger = require('../../utils/logger');

/**
 * Ledger Repository - Data access layer for ledger entries
 */
class LedgerRepository {
    constructor(databaseClient) {
        this.db = databaseClient;
    }

    /**
     * Create a ledger entry
     */
    async create(entry, client = null) {
        const executor = client || this.db;

        const query = `
      INSERT INTO ledger_entries (
        id, wallet_id, transaction_type, amount, balance_after,
        currency, reference_id, reference_type, idempotency_key,
        description, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING *
    `;

        const values = [
            entry.id || uuidv4(),
            entry.walletId,
            entry.transactionType,
            entry.amount,
            entry.balanceAfter,
            entry.currency,
            entry.referenceId,
            entry.referenceType,
            entry.idempotencyKey,
            entry.description,
            JSON.stringify(entry.metadata || {})
        ];

        try {
            const result = await executor.query(query, values);
            logger.info('Ledger entry created', {
                ledgerId: result.rows[0].id,
                walletId: entry.walletId,
                type: entry.transactionType,
                amount: entry.amount
            });
            return this.mapRowToEntry(result.rows[0]);
        } catch (error) {
            if (error.code === '23505') { // Unique constraint violation
                logger.warn('Duplicate ledger entry attempt', {
                    idempotencyKey: entry.idempotencyKey
                });
                throw new Error('DUPLICATE_LEDGER_ENTRY');
            }
            logger.error('Error creating ledger entry', {
                error: error.message,
                walletId: entry.walletId
            });
            throw error;
        }
    }

    /**
     * Check if ledger entry exists by idempotency key
     */
    async existsByIdempotencyKey(idempotencyKey, client = null) {
        const executor = client || this.db;

        const query = `
      SELECT EXISTS(
        SELECT 1 FROM ledger_entries WHERE idempotency_key = $1
      ) as exists
    `;

        try {
            const result = await executor.query(query, [idempotencyKey]);
            return result.rows[0].exists;
        } catch (error) {
            logger.error('Error checking ledger entry existence', {
                error: error.message,
                idempotencyKey
            });
            throw error;
        }
    }

    /**
     * Find ledger entry by idempotency key
     */
    async findByIdempotencyKey(idempotencyKey, client = null) {
        const executor = client || this.db;

        const query = `SELECT * FROM ledger_entries WHERE idempotency_key = $1`;

        try {
            const result = await executor.query(query, [idempotencyKey]);
            if (result.rows.length === 0) {
                return null;
            }
            return this.mapRowToEntry(result.rows[0]);
        } catch (error) {
            logger.error('Error finding ledger entry', {
                error: error.message,
                idempotencyKey
            });
            throw error;
        }
    }

    /**
     * Find ledger entries by wallet ID
     */
    async findByWalletId(walletId, limit = 50, offset = 0) {
        const query = `
      SELECT * FROM ledger_entries
      WHERE wallet_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;

        try {
            const result = await this.db.query(query, [walletId, limit, offset]);
            return result.rows.map(row => this.mapRowToEntry(row));
        } catch (error) {
            logger.error('Error finding ledger entries', {
                error: error.message,
                walletId
            });
            throw error;
        }
    }

    /**
     * Calculate balance from ledger (for reconciliation)
     */
    async calculateBalance(walletId, client = null) {
        const executor = client || this.db;

        const query = `
      SELECT COALESCE(SUM(amount), 0) as total
      FROM ledger_entries
      WHERE wallet_id = $1
    `;

        try {
            const result = await executor.query(query, [walletId]);
            return parseInt(result.rows[0].total);
        } catch (error) {
            logger.error('Error calculating balance from ledger', {
                error: error.message,
                walletId
            });
            throw error;
        }
    }

    /**
     * Map database row to ledger entry object
     */
    mapRowToEntry(row) {
        return {
            id: row.id,
            walletId: row.wallet_id,
            transactionType: row.transaction_type,
            amount: parseInt(row.amount),
            balanceAfter: parseInt(row.balance_after),
            currency: row.currency,
            referenceId: row.reference_id,
            referenceType: row.reference_type,
            idempotencyKey: row.idempotency_key,
            description: row.description,
            metadata: row.metadata,
            createdAt: row.created_at
        };
    }
}

module.exports = LedgerRepository;
