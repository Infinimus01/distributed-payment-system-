const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const App = require('../../src/index');
const DatabaseClient = require('../../src/infrastructure/database/DatabaseClient');

/**
 * Integration Tests - Wallet Service
 * 
 * Tests concurrent wallet debit scenarios
 */
describe('Wallet Service - Integration Tests', () => {
    let app;
    let server;
    let db;

    beforeAll(async () => {
        // Initialize application
        const appInstance = new App();
        await appInstance.initialize();
        app = appInstance.app;
        server = appInstance.server;
        db = appInstance.db;
    });

    afterAll(async () => {
        // Cleanup
        if (db) await db.close();
        if (server) server.close();
    });

    afterEach(async () => {
        // Clean up test data
        try {
            await db.query('DELETE FROM ledger_entries WHERE idempotency_key LIKE $1', ['test_%']);
            await db.query('DELETE FROM wallets WHERE user_id LIKE $1', ['user-integration-%']);
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    });

    describe('Scenario: Concurrent Wallet Debit', () => {
        test('should handle concurrent debit requests with same idempotency key', async () => {
            // Create wallet
            const userId = `user-integration-${uuidv4()}`;
            const createResponse = await request(app)
                .post('/wallets/create')
                .send({
                    userId,
                    currency: 'USD',
                    initialBalance: 10000
                })
                .expect(201);

            const walletId = createResponse.body.data.wallet.id;
            const idempotencyKey = `test_concurrent_debit_${uuidv4()}`;

            // Send two concurrent debit requests with same idempotency key
            const [response1, response2] = await Promise.all([
                request(app)
                    .post('/wallets/debit')
                    .send({
                        walletId,
                        amount: 5000,
                        idempotencyKey,
                        referenceId: 'payment-test-1',
                        referenceType: 'PAYMENT',
                        description: 'Concurrent test 1'
                    }),
                request(app)
                    .post('/wallets/debit')
                    .send({
                        walletId,
                        amount: 5000,
                        idempotencyKey,
                        referenceId: 'payment-test-1',
                        referenceType: 'PAYMENT',
                        description: 'Concurrent test 2'
                    })
            ]);

            // Both should succeed
            expect(response1.status).toBe(200);
            expect(response2.status).toBe(200);

            // One should be original, one should be duplicate
            const duplicates = [
                response1.body.data.duplicate,
                response2.body.data.duplicate
            ];
            expect(duplicates).toContain(false); // One original
            expect(duplicates).toContain(true);  // One duplicate

            // Both should return same ledger entry ID
            const ledgerId1 = response1.body.data.ledgerEntry.id;
            const ledgerId2 = response2.body.data.ledgerEntry.id;
            expect(ledgerId1).toBe(ledgerId2);

            // Final balance should be 5000 (debited once, not twice)
            const finalBalance1 = response1.body.data.wallet.balance;
            const finalBalance2 = response2.body.data.wallet.balance;
            expect(finalBalance1).toBe(5000);
            expect(finalBalance2).toBe(5000);

            // Verify only one ledger entry in database
            const result = await db.query(
                'SELECT COUNT(*) FROM ledger_entries WHERE idempotency_key = $1',
                [idempotencyKey]
            );
            expect(parseInt(result.rows[0].count)).toBe(1);
        });

        test('should handle concurrent debits with different idempotency keys', async () => {
            // Create wallet
            const userId = `user-integration-${uuidv4()}`;
            const createResponse = await request(app)
                .post('/wallets/create')
                .send({
                    userId,
                    currency: 'USD',
                    initialBalance: 10000
                })
                .expect(201);

            const walletId = createResponse.body.data.wallet.id;

            // Send two concurrent debit requests with different idempotency keys
            const [response1, response2] = await Promise.all([
                request(app)
                    .post('/wallets/debit')
                    .send({
                        walletId,
                        amount: 3000,
                        idempotencyKey: `test_debit_1_${uuidv4()}`,
                        referenceId: 'payment-test-1',
                        referenceType: 'PAYMENT',
                        description: 'Debit 1'
                    }),
                request(app)
                    .post('/wallets/debit')
                    .send({
                        walletId,
                        amount: 2000,
                        idempotencyKey: `test_debit_2_${uuidv4()}`,
                        referenceId: 'payment-test-2',
                        referenceType: 'PAYMENT',
                        description: 'Debit 2'
                    })
            ]);

            // Both should succeed
            expect(response1.status).toBe(200);
            expect(response2.status).toBe(200);

            // Both should be original (not duplicates)
            expect(response1.body.data.duplicate).toBe(false);
            expect(response2.body.data.duplicate).toBe(false);

            // Final balance should be 5000 (10000 - 3000 - 2000)
            // Note: Due to concurrency, we need to check the final state
            const walletResponse = await request(app)
                .get(`/wallets/${walletId}`)
                .expect(200);

            expect(walletResponse.body.data.wallet.balance).toBe(5000);

            // Verify two ledger entries
            const result = await db.query(
                'SELECT COUNT(*) FROM ledger_entries WHERE wallet_id = $1',
                [walletId]
            );
            expect(parseInt(result.rows[0].count)).toBe(2);
        });

        test('should prevent double-spend with concurrent debits', async () => {
            // Create wallet with limited balance
            const userId = `user-integration-${uuidv4()}`;
            const createResponse = await request(app)
                .post('/wallets/create')
                .send({
                    userId,
                    currency: 'USD',
                    initialBalance: 5000
                })
                .expect(201);

            const walletId = createResponse.body.data.wallet.id;

            // Try to debit more than available balance concurrently
            const [response1, response2] = await Promise.all([
                request(app)
                    .post('/wallets/debit')
                    .send({
                        walletId,
                        amount: 4000,
                        idempotencyKey: `test_overspend_1_${uuidv4()}`,
                        referenceId: 'payment-test-1',
                        referenceType: 'PAYMENT',
                        description: 'Debit 1'
                    }),
                request(app)
                    .post('/wallets/debit')
                    .send({
                        walletId,
                        amount: 4000,
                        idempotencyKey: `test_overspend_2_${uuidv4()}`,
                        referenceId: 'payment-test-2',
                        referenceType: 'PAYMENT',
                        description: 'Debit 2'
                    })
            ]);

            // One should succeed, one should fail with insufficient balance
            const statuses = [response1.status, response2.status].sort();

            // One 200 (success), one 422 (insufficient balance)
            expect(statuses).toContain(200);
            expect(statuses).toContain(422);

            // Find the failed response
            const failedResponse = response1.status === 422 ? response1 : response2;
            expect(failedResponse.body.error).toBe('INSUFFICIENT_BALANCE');

            // Final balance should be 1000 (5000 - 4000)
            const walletResponse = await request(app)
                .get(`/wallets/${walletId}`)
                .expect(200);

            expect(walletResponse.body.data.wallet.balance).toBe(1000);

            // Verify only one ledger entry (successful debit)
            const result = await db.query(
                'SELECT COUNT(*) FROM ledger_entries WHERE wallet_id = $1',
                [walletId]
            );
            expect(parseInt(result.rows[0].count)).toBe(1);
        });
    });

    describe('Scenario: Idempotent Operations', () => {
        test('should return same result for duplicate debit request', async () => {
            // Create wallet
            const userId = `user-integration-${uuidv4()}`;
            const createResponse = await request(app)
                .post('/wallets/create')
                .send({
                    userId,
                    currency: 'USD',
                    initialBalance: 10000
                })
                .expect(201);

            const walletId = createResponse.body.data.wallet.id;
            const idempotencyKey = `test_idempotent_${uuidv4()}`;

            // First debit
            const response1 = await request(app)
                .post('/wallets/debit')
                .send({
                    walletId,
                    amount: 3000,
                    idempotencyKey,
                    referenceId: 'payment-test',
                    referenceType: 'PAYMENT',
                    description: 'Idempotent test'
                })
                .expect(200);

            expect(response1.body.data.duplicate).toBe(false);
            expect(response1.body.data.wallet.balance).toBe(7000);
            const ledgerId1 = response1.body.data.ledgerEntry.id;

            // Second debit (duplicate)
            const response2 = await request(app)
                .post('/wallets/debit')
                .send({
                    walletId,
                    amount: 3000,
                    idempotencyKey,
                    referenceId: 'payment-test',
                    referenceType: 'PAYMENT',
                    description: 'Idempotent test'
                })
                .expect(200);

            expect(response2.body.data.duplicate).toBe(true);
            expect(response2.body.data.wallet.balance).toBe(7000); // Same balance
            expect(response2.body.data.ledgerEntry.id).toBe(ledgerId1); // Same ledger entry

            // Verify only one ledger entry
            const result = await db.query(
                'SELECT COUNT(*) FROM ledger_entries WHERE idempotency_key = $1',
                [idempotencyKey]
            );
            expect(parseInt(result.rows[0].count)).toBe(1);
        });
    });

    describe('Scenario: Balance Consistency', () => {
        test('should maintain correct balance after multiple operations', async () => {
            // Create wallet
            const userId = `user-integration-${uuidv4()}`;
            const createResponse = await request(app)
                .post('/wallets/create')
                .send({
                    userId,
                    currency: 'USD',
                    initialBalance: 10000
                })
                .expect(201);

            const walletId = createResponse.body.data.wallet.id;

            // Perform multiple operations
            await request(app)
                .post('/wallets/debit')
                .send({
                    walletId,
                    amount: 2000,
                    idempotencyKey: `test_op_1_${uuidv4()}`,
                    referenceId: 'payment-1',
                    referenceType: 'PAYMENT',
                    description: 'Debit 1'
                })
                .expect(200);

            await request(app)
                .post('/wallets/credit')
                .send({
                    walletId,
                    amount: 1000,
                    idempotencyKey: `test_op_2_${uuidv4()}`,
                    referenceId: 'refund-1',
                    referenceType: 'REFUND',
                    description: 'Credit 1'
                })
                .expect(200);

            await request(app)
                .post('/wallets/debit')
                .send({
                    walletId,
                    amount: 3000,
                    idempotencyKey: `test_op_3_${uuidv4()}`,
                    referenceId: 'payment-2',
                    referenceType: 'PAYMENT',
                    description: 'Debit 2'
                })
                .expect(200);

            // Final balance: 10000 - 2000 + 1000 - 3000 = 6000
            const walletResponse = await request(app)
                .get(`/wallets/${walletId}`)
                .expect(200);

            expect(walletResponse.body.data.wallet.balance).toBe(6000);

            // Verify ledger entries
            const result = await db.query(
                'SELECT SUM(amount) as total FROM ledger_entries WHERE wallet_id = $1',
                [walletId]
            );

            // Total: -2000 + 1000 - 3000 = -4000
            expect(parseInt(result.rows[0].total)).toBe(-4000);
        });
    });
});
