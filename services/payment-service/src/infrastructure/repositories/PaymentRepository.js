const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

/**
 * Payment Repository - Data access layer for payments
 */
class PaymentRepository {
    constructor(databaseClient) {
        this.db = databaseClient;
    }

    /**
     * Create a new payment
     */
    async create(payment, client = null) {
        const executor = client || this.db;

        const query = `
      INSERT INTO payments (
        id, user_id, amount, currency, status, idempotency_key,
        merchant_id, description, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      RETURNING *
    `;

        const values = [
            payment.id || uuidv4(),
            payment.userId,
            payment.amount,
            payment.currency,
            payment.status || 'PENDING',
            payment.idempotencyKey,
            payment.merchantId,
            payment.description,
            JSON.stringify(payment.metadata || {})
        ];

        try {
            const result = await executor.query(query, values);
            logger.info('Payment created', {
                paymentId: result.rows[0].id,
                userId: payment.userId,
                amount: payment.amount
            });
            return this.mapRowToPayment(result.rows[0]);
        } catch (error) {
            if (error.code === '23505') { // Unique constraint violation
                logger.warn('Duplicate payment attempt', {
                    idempotencyKey: payment.idempotencyKey
                });
                throw new Error('DUPLICATE_PAYMENT');
            }
            logger.error('Error creating payment', {
                error: error.message,
                userId: payment.userId
            });
            throw error;
        }
    }

    /**
     * Find payment by ID
     */
    async findById(id, options = {}) {
        const { forUpdate = false, client = null } = options;
        const executor = client || this.db;

        const lockClause = forUpdate ? 'FOR UPDATE' : '';
        const query = `SELECT * FROM payments WHERE id = $1 ${lockClause}`;

        try {
            const result = await executor.query(query, [id]);
            if (result.rows.length === 0) {
                return null;
            }
            return this.mapRowToPayment(result.rows[0]);
        } catch (error) {
            logger.error('Error finding payment by ID', { error: error.message, id });
            throw error;
        }
    }

    /**
     * Find payment by idempotency key
     */
    async findByIdempotencyKey(idempotencyKey, client = null) {
        const executor = client || this.db;

        const query = 'SELECT * FROM payments WHERE idempotency_key = $1';

        try {
            const result = await executor.query(query, [idempotencyKey]);
            if (result.rows.length === 0) {
                return null;
            }
            return this.mapRowToPayment(result.rows[0]);
        } catch (error) {
            logger.error('Error finding payment by idempotency key', {
                error: error.message,
                idempotencyKey
            });
            throw error;
        }
    }

    /**
     * Update payment status
     */
    async updateStatus(paymentId, status, additionalFields = {}, client = null) {
        const executor = client || this.db;

        const query = `
      UPDATE payments
      SET status = $1,
          gateway_transaction_id = COALESCE($2, gateway_transaction_id),
          failure_reason = $3,
          processed_at = $4,
          updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `;

        const values = [
            status,
            additionalFields.gatewayTransactionId || null,
            additionalFields.failureReason || null,
            additionalFields.processedAt || null,
            paymentId
        ];

        try {
            const result = await executor.query(query, values);
            if (result.rows.length === 0) {
                throw new Error('PAYMENT_NOT_FOUND');
            }
            logger.info('Payment status updated', {
                paymentId,
                status
            });
            return this.mapRowToPayment(result.rows[0]);
        } catch (error) {
            logger.error('Error updating payment status', {
                error: error.message,
                paymentId
            });
            throw error;
        }
    }

    /**
     * Find payments by user ID
     */
    async findByUserId(userId, limit = 10, offset = 0) {
        const query = `
      SELECT * FROM payments
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;

        try {
            const result = await this.db.query(query, [userId, limit, offset]);
            return result.rows.map(row => this.mapRowToPayment(row));
        } catch (error) {
            logger.error('Error finding payments by user ID', {
                error: error.message,
                userId
            });
            throw error;
        }
    }

    /**
     * Map database row to payment object
     */
    mapRowToPayment(row) {
        return {
            id: row.id,
            userId: row.user_id,
            amount: parseInt(row.amount),
            currency: row.currency,
            status: row.status,
            idempotencyKey: row.idempotency_key,
            merchantId: row.merchant_id,
            description: row.description,
            metadata: row.metadata,
            gatewayTransactionId: row.gateway_transaction_id,
            failureReason: row.failure_reason,
            retryCount: row.retry_count,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            processedAt: row.processed_at
        };
    }
}

module.exports = PaymentRepository;
