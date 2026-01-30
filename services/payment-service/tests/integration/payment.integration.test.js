const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const App = require('../../src/index');
const DatabaseClient = require('../../src/infrastructure/database/DatabaseClient');
const RedisClient = require('../../src/infrastructure/cache/RedisClient');
const config = require('../../src/config');

/**
 * Integration Tests - Payment Service
 * 
 * Tests real scenarios with actual database and Redis
 */
describe('Payment Service - Integration Tests', () => {
    let app;
    let server;
    let db;
    let redis;

    beforeAll(async () => {
        // Initialize application
        const appInstance = new App();
        await appInstance.initialize();
        app = appInstance.app;
        server = appInstance.server;
        db = appInstance.db;
        redis = appInstance.redis;
    });

    afterAll(async () => {
        // Cleanup
        if (db) await db.close();
        if (redis) await redis.close();
        if (server) server.close();
    });

    afterEach(async () => {
        // Clean up test data
        try {
            await db.query('DELETE FROM payments WHERE idempotency_key LIKE $1', ['test_%']);
            await db.query('DELETE FROM payment_events WHERE payment_id LIKE $1', ['test_%']);
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    });

    describe('Scenario: Duplicate Payment Request', () => {
        test('should return same payment for duplicate idempotency key (Redis cache)', async () => {
            const idempotencyKey = `test_duplicate_${uuidv4()}`;
            const paymentData = {
                userId: 'user-integration-test',
                amount: 5000,
                currency: 'USD',
                merchantId: 'merchant-test',
                description: 'Integration test payment'
            };

            // First request - creates payment
            const response1 = await request(app)
                .post('/payments')
                .set('Idempotency-Key', idempotencyKey)
                .send(paymentData)
                .expect(201);

            expect(response1.body.success).toBe(true);
            expect(response1.body.data.duplicate).toBe(false);
            expect(response1.body.data.source).toBe('created');

            const paymentId1 = response1.body.data.payment.id;

            // Second request - returns cached payment
            const response2 = await request(app)
                .post('/payments')
                .set('Idempotency-Key', idempotencyKey)
                .send(paymentData)
                .expect(200);

            expect(response2.body.success).toBe(true);
            expect(response2.body.data.duplicate).toBe(true);
            expect(response2.body.data.source).toBe('cache');
            expect(response2.body.data.payment.id).toBe(paymentId1);

            // Verify only one payment in database
            const result = await db.query(
                'SELECT COUNT(*) FROM payments WHERE idempotency_key = $1',
                [idempotencyKey]
            );
            expect(parseInt(result.rows[0].count)).toBe(1);
        });

        test('should return same payment for duplicate after cache expiry (Database)', async () => {
            const idempotencyKey = `test_duplicate_db_${uuidv4()}`;
            const paymentData = {
                userId: 'user-integration-test',
                amount: 3000,
                currency: 'USD',
                merchantId: 'merchant-test',
                description: 'Cache expiry test'
            };

            // First request
            const response1 = await request(app)
                .post('/payments')
                .set('Idempotency-Key', idempotencyKey)
                .send(paymentData)
                .expect(201);

            const paymentId1 = response1.body.data.payment.id;

            // Manually delete from Redis to simulate cache expiry
            await redis.del(`idempotency:${idempotencyKey}`);

            // Second request - should fetch from database
            const response2 = await request(app)
                .post('/payments')
                .set('Idempotency-Key', idempotencyKey)
                .send(paymentData)
                .expect(200);

            expect(response2.body.success).toBe(true);
            expect(response2.body.data.duplicate).toBe(true);
            expect(response2.body.data.source).toBe('database');
            expect(response2.body.data.payment.id).toBe(paymentId1);

            // Verify still only one payment
            const result = await db.query(
                'SELECT COUNT(*) FROM payments WHERE idempotency_key = $1',
                [idempotencyKey]
            );
            expect(parseInt(result.rows[0].count)).toBe(1);
        });

        test('should handle concurrent duplicate requests (Race condition)', async () => {
            const idempotencyKey = `test_concurrent_${uuidv4()}`;
            const paymentData = {
                userId: 'user-integration-test',
                amount: 2000,
                currency: 'USD',
                merchantId: 'merchant-test',
                description: 'Concurrent test'
            };

            // Send two requests concurrently
            const [response1, response2] = await Promise.all([
                request(app)
                    .post('/payments')
                    .set('Idempotency-Key', idempotencyKey)
                    .send(paymentData),
                request(app)
                    .post('/payments')
                    .set('Idempotency-Key', idempotencyKey)
                    .send(paymentData)
            ]);

            // One should be 201 (created), one should be 200 (duplicate)
            const statuses = [response1.status, response2.status].sort();
            expect(statuses).toEqual([200, 201]);

            // Both should return same payment ID
            const paymentId1 = response1.body.data.payment.id;
            const paymentId2 = response2.body.data.payment.id;
            expect(paymentId1).toBe(paymentId2);

            // Verify only one payment in database
            const result = await db.query(
                'SELECT COUNT(*) FROM payments WHERE idempotency_key = $1',
                [idempotencyKey]
            );
            expect(parseInt(result.rows[0].count)).toBe(1);
        });
    });

    describe('Scenario: Redis Downtime', () => {
        test('should fallback to database when Redis is unavailable', async () => {
            const idempotencyKey = `test_redis_down_${uuidv4()}`;
            const paymentData = {
                userId: 'user-integration-test',
                amount: 1000,
                currency: 'USD',
                merchantId: 'merchant-test',
                description: 'Redis downtime test'
            };

            // Temporarily close Redis connection
            await redis.close();

            // Request should still succeed (fallback to database)
            const response = await request(app)
                .post('/payments')
                .set('Idempotency-Key', idempotencyKey)
                .send(paymentData)
                .expect(201);

            expect(response.body.success).toBe(true);
            expect(response.body.data.payment.id).toBeDefined();

            // Verify payment in database
            const result = await db.query(
                'SELECT * FROM payments WHERE idempotency_key = $1',
                [idempotencyKey]
            );
            expect(result.rows.length).toBe(1);

            // Reconnect Redis for other tests
            await redis.connect();
        });
    });

    describe('Scenario: Payment Status Transitions', () => {
        test('should transition payment from PENDING → PROCESSING → COMPLETED', async () => {
            const idempotencyKey = `test_status_${uuidv4()}`;
            const paymentData = {
                userId: 'user-integration-test',
                amount: 4000,
                currency: 'USD',
                merchantId: 'merchant-test',
                description: 'Status transition test'
            };

            // Create payment
            const createResponse = await request(app)
                .post('/payments')
                .set('Idempotency-Key', idempotencyKey)
                .send(paymentData)
                .expect(201);

            const paymentId = createResponse.body.data.payment.id;
            expect(createResponse.body.data.payment.status).toBe('PENDING');

            // Update to PROCESSING
            const processingResponse = await request(app)
                .patch(`/payments/${paymentId}/status`)
                .send({ status: 'PROCESSING' })
                .expect(200);

            expect(processingResponse.body.data.payment.status).toBe('PROCESSING');

            // Update to COMPLETED
            const completedResponse = await request(app)
                .patch(`/payments/${paymentId}/status`)
                .send({
                    status: 'COMPLETED',
                    gatewayTransactionId: 'txn_test_123'
                })
                .expect(200);

            expect(completedResponse.body.data.payment.status).toBe('COMPLETED');
            expect(completedResponse.body.data.payment.gatewayTransactionId).toBe('txn_test_123');

            // Verify in database
            const result = await db.query(
                'SELECT status, gateway_transaction_id FROM payments WHERE id = $1',
                [paymentId]
            );
            expect(result.rows[0].status).toBe('COMPLETED');
            expect(result.rows[0].gateway_transaction_id).toBe('txn_test_123');
        });
    });

    describe('Scenario: Get Payment Operations', () => {
        test('should retrieve payment by ID', async () => {
            const idempotencyKey = `test_get_${uuidv4()}`;
            const paymentData = {
                userId: 'user-integration-test',
                amount: 1500,
                currency: 'USD',
                merchantId: 'merchant-test',
                description: 'Get payment test'
            };

            // Create payment
            const createResponse = await request(app)
                .post('/payments')
                .set('Idempotency-Key', idempotencyKey)
                .send(paymentData)
                .expect(201);

            const paymentId = createResponse.body.data.payment.id;

            // Get payment
            const getResponse = await request(app)
                .get(`/payments/${paymentId}`)
                .expect(200);

            expect(getResponse.body.success).toBe(true);
            expect(getResponse.body.data.payment.id).toBe(paymentId);
            expect(getResponse.body.data.payment.amount).toBe(1500);
            expect(getResponse.body.data.payment.userId).toBe('user-integration-test');
        });

        test('should retrieve payments by user ID', async () => {
            const userId = `user-integration-${uuidv4()}`;

            // Create multiple payments
            for (let i = 0; i < 3; i++) {
                await request(app)
                    .post('/payments')
                    .set('Idempotency-Key', `test_user_${userId}_${i}`)
                    .send({
                        userId,
                        amount: 1000 * (i + 1),
                        currency: 'USD',
                        merchantId: 'merchant-test',
                        description: `Payment ${i + 1}`
                    })
                    .expect(201);
            }

            // Get payments by user
            const response = await request(app)
                .get(`/payments/user/${userId}`)
                .query({ limit: 10, offset: 0 })
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data.payments.length).toBe(3);
            expect(response.body.data.pagination.count).toBe(3);
        });
    });

    describe('Scenario: Error Handling', () => {
        test('should return 400 for missing idempotency key', async () => {
            const response = await request(app)
                .post('/payments')
                .send({
                    userId: 'user-test',
                    amount: 1000,
                    currency: 'USD',
                    merchantId: 'merchant-test'
                })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('INVALID_INPUT');
        });

        test('should return 400 for invalid amount', async () => {
            const response = await request(app)
                .post('/payments')
                .set('Idempotency-Key', `test_invalid_${uuidv4()}`)
                .send({
                    userId: 'user-test',
                    amount: -1000,
                    currency: 'USD',
                    merchantId: 'merchant-test'
                })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('INVALID_INPUT');
        });

        test('should return 404 for non-existent payment', async () => {
            const response = await request(app)
                .get('/payments/non-existent-id')
                .expect(404);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('PAYMENT_NOT_FOUND');
        });
    });
});
