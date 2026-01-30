const PaymentService = require('../../src/services/PaymentService');

describe('PaymentService - Idempotency Behavior', () => {
    let paymentService;
    let mockPaymentRepo;
    let mockIdempotencyService;
    let mockEventPublisher;
    let mockDb;

    beforeEach(() => {
        // Mock payment repository
        mockPaymentRepo = {
            create: jest.fn(),
            findById: jest.fn(),
            findByIdempotencyKey: jest.fn(),
            updateStatus: jest.fn()
        };

        // Mock idempotency service
        mockIdempotencyService = {
            getPayment: jest.fn(),
            storePayment: jest.fn(),
            deletePayment: jest.fn()
        };

        // Mock event publisher
        mockEventPublisher = {
            publishPaymentCreated: jest.fn(),
            publishPaymentStatusChanged: jest.fn()
        };

        // Mock database client
        mockDb = {
            transaction: jest.fn(),
            query: jest.fn()
        };

        paymentService = new PaymentService(
            mockPaymentRepo,
            mockIdempotencyService,
            mockEventPublisher,
            mockDb
        );
    });

    describe('createPayment - Idempotency from Redis Cache', () => {
        test('should return cached payment if idempotency key exists in Redis', async () => {
            const idempotencyKey = 'payment_123_abc';
            const cachedPayment = {
                id: 'payment-001',
                userId: 'user-123',
                amount: 1000,
                currency: 'USD',
                status: 'PENDING',
                merchantId: 'merchant-001',
                idempotencyKey,
                createdAt: new Date()
            };

            // Mock: Redis cache hit
            mockIdempotencyService.getPayment.mockResolvedValue(cachedPayment);

            const result = await paymentService.createPayment({
                userId: 'user-123',
                amount: 1000,
                currency: 'USD',
                merchantId: 'merchant-001',
                idempotencyKey
            });

            // Assertions
            expect(result.duplicate).toBe(true);
            expect(result.source).toBe('cache');
            expect(result.payment.id).toBe('payment-001');

            // Verify cache was checked
            expect(mockIdempotencyService.getPayment).toHaveBeenCalledWith(idempotencyKey);

            // Verify no database operations occurred
            expect(mockPaymentRepo.findByIdempotencyKey).not.toHaveBeenCalled();
            expect(mockPaymentRepo.create).not.toHaveBeenCalled();

            // Verify no event was published
            expect(mockEventPublisher.publishPaymentCreated).not.toHaveBeenCalled();
        });
    });

    describe('createPayment - Idempotency from Database', () => {
        test('should return DB payment if cache miss but DB has payment', async () => {
            const idempotencyKey = 'payment_123_def';
            const dbPayment = {
                id: 'payment-002',
                userId: 'user-123',
                amount: 2000,
                currency: 'USD',
                status: 'PENDING',
                merchantId: 'merchant-001',
                idempotencyKey,
                createdAt: new Date()
            };

            // Mock: Redis cache miss
            mockIdempotencyService.getPayment.mockResolvedValue(null);

            // Mock: Database has payment
            mockPaymentRepo.findByIdempotencyKey.mockResolvedValue(dbPayment);

            // Mock: Re-cache in Redis
            mockIdempotencyService.storePayment.mockResolvedValue();

            const result = await paymentService.createPayment({
                userId: 'user-123',
                amount: 2000,
                currency: 'USD',
                merchantId: 'merchant-001',
                idempotencyKey
            });

            // Assertions
            expect(result.duplicate).toBe(true);
            expect(result.source).toBe('database');
            expect(result.payment.id).toBe('payment-002');

            // Verify cache was checked first
            expect(mockIdempotencyService.getPayment).toHaveBeenCalledWith(idempotencyKey);

            // Verify database was checked
            expect(mockPaymentRepo.findByIdempotencyKey).toHaveBeenCalledWith(idempotencyKey);

            // Verify payment was re-cached in Redis
            expect(mockIdempotencyService.storePayment).toHaveBeenCalledWith(
                idempotencyKey,
                dbPayment
            );

            // Verify no new payment was created
            expect(mockPaymentRepo.create).not.toHaveBeenCalled();

            // Verify no event was published
            expect(mockEventPublisher.publishPaymentCreated).not.toHaveBeenCalled();
        });
    });

    describe('createPayment - New Payment Creation', () => {
        test('should create new payment if idempotency key is new', async () => {
            const idempotencyKey = 'payment_123_ghi';
            const newPayment = {
                id: 'payment-003',
                userId: 'user-123',
                amount: 3000,
                currency: 'USD',
                status: 'PENDING',
                merchantId: 'merchant-001',
                idempotencyKey,
                description: 'Payment to merchant-001',
                metadata: {},
                createdAt: new Date()
            };

            // Mock: Redis cache miss
            mockIdempotencyService.getPayment.mockResolvedValue(null);

            // Mock: Database has no payment
            mockPaymentRepo.findByIdempotencyKey.mockResolvedValue(null);

            // Mock: Payment creation succeeds
            mockPaymentRepo.create.mockResolvedValue(newPayment);

            // Mock: Cache storage succeeds
            mockIdempotencyService.storePayment.mockResolvedValue();

            // Mock: Event publishing succeeds
            mockEventPublisher.publishPaymentCreated.mockResolvedValue();

            const result = await paymentService.createPayment({
                userId: 'user-123',
                amount: 3000,
                currency: 'USD',
                merchantId: 'merchant-001',
                idempotencyKey
            });

            // Assertions
            expect(result.duplicate).toBe(false);
            expect(result.source).toBe('created');
            expect(result.payment.id).toBe('payment-003');

            // Verify cache was checked
            expect(mockIdempotencyService.getPayment).toHaveBeenCalledWith(idempotencyKey);

            // Verify database was checked
            expect(mockPaymentRepo.findByIdempotencyKey).toHaveBeenCalledWith(idempotencyKey);

            // Verify payment was created
            expect(mockPaymentRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-123',
                    amount: 3000,
                    currency: 'USD',
                    status: 'PENDING',
                    merchantId: 'merchant-001',
                    idempotencyKey
                })
            );

            // Verify payment was cached
            expect(mockIdempotencyService.storePayment).toHaveBeenCalledWith(
                idempotencyKey,
                newPayment
            );

            // Verify event was published
            expect(mockEventPublisher.publishPaymentCreated).toHaveBeenCalledWith(newPayment);
        });
    });

    describe('createPayment - Race Condition Handling', () => {
        test('should handle race condition when duplicate payment created between checks', async () => {
            const idempotencyKey = 'payment_123_jkl';
            const existingPayment = {
                id: 'payment-004',
                userId: 'user-123',
                amount: 4000,
                currency: 'USD',
                status: 'PENDING',
                merchantId: 'merchant-001',
                idempotencyKey,
                createdAt: new Date()
            };

            // Mock: Redis cache miss
            mockIdempotencyService.getPayment.mockResolvedValue(null);

            // Mock: Database check returns null (payment doesn't exist yet)
            mockPaymentRepo.findByIdempotencyKey
                .mockResolvedValueOnce(null)  // First check: no payment
                .mockResolvedValueOnce(existingPayment);  // Second check: payment exists

            // Mock: Payment creation fails with duplicate error
            mockPaymentRepo.create.mockRejectedValue(new Error('DUPLICATE_PAYMENT'));

            // Mock: Cache storage succeeds
            mockIdempotencyService.storePayment.mockResolvedValue();

            const result = await paymentService.createPayment({
                userId: 'user-123',
                amount: 4000,
                currency: 'USD',
                merchantId: 'merchant-001',
                idempotencyKey
            });

            // Assertions
            expect(result.duplicate).toBe(true);
            expect(result.source).toBe('race_condition');
            expect(result.payment.id).toBe('payment-004');

            // Verify payment was fetched after duplicate error
            expect(mockPaymentRepo.findByIdempotencyKey).toHaveBeenCalledTimes(2);

            // Verify payment was cached
            expect(mockIdempotencyService.storePayment).toHaveBeenCalledWith(
                idempotencyKey,
                existingPayment
            );
        });
    });

    describe('createPayment - Validation', () => {
        test('should throw error if idempotencyKey is missing', async () => {
            await expect(
                paymentService.createPayment({
                    userId: 'user-123',
                    amount: 1000,
                    currency: 'USD',
                    merchantId: 'merchant-001'
                })
            ).rejects.toThrow('INVALID_INPUT: idempotencyKey is required');
        });

        test('should throw error if userId is missing', async () => {
            await expect(
                paymentService.createPayment({
                    amount: 1000,
                    currency: 'USD',
                    merchantId: 'merchant-001',
                    idempotencyKey: 'key-001'
                })
            ).rejects.toThrow('INVALID_INPUT: userId is required');
        });

        test('should throw error if amount is zero', async () => {
            await expect(
                paymentService.createPayment({
                    userId: 'user-123',
                    amount: 0,
                    currency: 'USD',
                    merchantId: 'merchant-001',
                    idempotencyKey: 'key-002'
                })
            ).rejects.toThrow('INVALID_INPUT: amount must be greater than 0');
        });

        test('should throw error if amount is negative', async () => {
            await expect(
                paymentService.createPayment({
                    userId: 'user-123',
                    amount: -1000,
                    currency: 'USD',
                    merchantId: 'merchant-001',
                    idempotencyKey: 'key-003'
                })
            ).rejects.toThrow('INVALID_INPUT: amount must be greater than 0');
        });

        test('should throw error if currency is invalid', async () => {
            await expect(
                paymentService.createPayment({
                    userId: 'user-123',
                    amount: 1000,
                    currency: 'INVALID',
                    merchantId: 'merchant-001',
                    idempotencyKey: 'key-004'
                })
            ).rejects.toThrow('INVALID_INPUT: Unsupported currency INVALID');
        });
    });

    describe('createPayment - Event Publishing', () => {
        test('should publish PaymentCreated event for new payment', async () => {
            const idempotencyKey = 'payment_123_mno';
            const newPayment = {
                id: 'payment-005',
                userId: 'user-123',
                amount: 5000,
                currency: 'USD',
                status: 'PENDING',
                merchantId: 'merchant-001',
                idempotencyKey,
                createdAt: new Date()
            };

            mockIdempotencyService.getPayment.mockResolvedValue(null);
            mockPaymentRepo.findByIdempotencyKey.mockResolvedValue(null);
            mockPaymentRepo.create.mockResolvedValue(newPayment);
            mockIdempotencyService.storePayment.mockResolvedValue();
            mockEventPublisher.publishPaymentCreated.mockResolvedValue();

            await paymentService.createPayment({
                userId: 'user-123',
                amount: 5000,
                currency: 'USD',
                merchantId: 'merchant-001',
                idempotencyKey
            });

            expect(mockEventPublisher.publishPaymentCreated).toHaveBeenCalledWith(newPayment);
        });

        test('should not publish event for duplicate payment', async () => {
            const cachedPayment = {
                id: 'payment-006',
                userId: 'user-123',
                amount: 6000,
                currency: 'USD',
                status: 'PENDING',
                merchantId: 'merchant-001',
                idempotencyKey: 'payment_123_pqr',
                createdAt: new Date()
            };

            mockIdempotencyService.getPayment.mockResolvedValue(cachedPayment);

            await paymentService.createPayment({
                userId: 'user-123',
                amount: 6000,
                currency: 'USD',
                merchantId: 'merchant-001',
                idempotencyKey: 'payment_123_pqr'
            });

            expect(mockEventPublisher.publishPaymentCreated).not.toHaveBeenCalled();
        });
    });

    describe('createPayment - Redis Failure Handling', () => {
        test('should proceed if Redis cache check fails', async () => {
            const idempotencyKey = 'payment_123_stu';
            const newPayment = {
                id: 'payment-007',
                userId: 'user-123',
                amount: 7000,
                currency: 'USD',
                status: 'PENDING',
                merchantId: 'merchant-001',
                idempotencyKey,
                createdAt: new Date()
            };

            // Mock: Redis fails
            mockIdempotencyService.getPayment.mockResolvedValue(null);

            // Mock: Database check succeeds
            mockPaymentRepo.findByIdempotencyKey.mockResolvedValue(null);

            // Mock: Payment creation succeeds
            mockPaymentRepo.create.mockResolvedValue(newPayment);

            // Mock: Cache storage fails (but doesn't throw)
            mockIdempotencyService.storePayment.mockResolvedValue();

            mockEventPublisher.publishPaymentCreated.mockResolvedValue();

            const result = await paymentService.createPayment({
                userId: 'user-123',
                amount: 7000,
                currency: 'USD',
                merchantId: 'merchant-001',
                idempotencyKey
            });

            // Payment should still be created
            expect(result.duplicate).toBe(false);
            expect(result.payment.id).toBe('payment-007');
        });
    });

    describe('createPayment - Multiple Concurrent Requests', () => {
        test('should handle same idempotency key from multiple concurrent requests', async () => {
            const idempotencyKey = 'payment_concurrent_001';
            const payment = {
                id: 'payment-008',
                userId: 'user-123',
                amount: 8000,
                currency: 'USD',
                status: 'PENDING',
                merchantId: 'merchant-001',
                idempotencyKey,
                createdAt: new Date()
            };

            // First request: cache miss, DB miss, creates payment
            mockIdempotencyService.getPayment.mockResolvedValueOnce(null);
            mockPaymentRepo.findByIdempotencyKey.mockResolvedValueOnce(null);
            mockPaymentRepo.create.mockResolvedValueOnce(payment);
            mockIdempotencyService.storePayment.mockResolvedValue();
            mockEventPublisher.publishPaymentCreated.mockResolvedValue();

            // Second request: cache hit
            mockIdempotencyService.getPayment.mockResolvedValueOnce(payment);

            // Execute both requests
            const result1 = await paymentService.createPayment({
                userId: 'user-123',
                amount: 8000,
                currency: 'USD',
                merchantId: 'merchant-001',
                idempotencyKey
            });

            const result2 = await paymentService.createPayment({
                userId: 'user-123',
                amount: 8000,
                currency: 'USD',
                merchantId: 'merchant-001',
                idempotencyKey
            });

            // First request creates payment
            expect(result1.duplicate).toBe(false);
            expect(result1.payment.id).toBe('payment-008');

            // Second request returns cached payment
            expect(result2.duplicate).toBe(true);
            expect(result2.source).toBe('cache');
            expect(result2.payment.id).toBe('payment-008');
        });
    });
});
