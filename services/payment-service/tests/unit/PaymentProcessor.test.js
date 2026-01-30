const PaymentProcessor = require('../../src/services/PaymentProcessor');

describe('PaymentProcessor - Wallet Integration & Retry Logic', () => {
    let paymentProcessor;
    let mockPaymentService;
    let mockWalletClient;
    let mockConfig;

    beforeEach(() => {
        // Mock payment service
        mockPaymentService = {
            updatePaymentStatus: jest.fn(),
            getPayment: jest.fn()
        };

        // Mock wallet client
        mockWalletClient = {
            debitWallet: jest.fn(),
            creditWallet: jest.fn()
        };

        // Mock config
        mockConfig = {
            payment: {
                maxRetryAttempts: 3,
                retryDelayMs: 100 // Shorter delay for tests
            }
        };

        paymentProcessor = new PaymentProcessor(
            mockPaymentService,
            mockWalletClient,
            mockConfig
        );
    });

    describe('processPayment - Success Cases', () => {
        test('should process payment successfully on first attempt', async () => {
            const payment = {
                id: 'payment-001',
                userId: 'user-123',
                amount: 1000,
                currency: 'USD',
                status: 'PENDING',
                description: 'Test payment'
            };

            const walletId = 'wallet-abc';

            // Mock: Status update to PROCESSING
            mockPaymentService.updatePaymentStatus.mockResolvedValueOnce({
                ...payment,
                status: 'PROCESSING'
            });

            // Mock: Wallet debit succeeds
            mockWalletClient.debitWallet.mockResolvedValueOnce({
                success: true,
                balance: 9000,
                ledgerEntryId: 'ledger-001',
                duplicate: false
            });

            // Mock: Status update to COMPLETED
            mockPaymentService.updatePaymentStatus.mockResolvedValueOnce({
                ...payment,
                status: 'COMPLETED',
                gatewayTransactionId: 'ledger-001'
            });

            const result = await paymentProcessor.processPayment(payment, walletId);

            // Assertions
            expect(result.success).toBe(true);
            expect(result.payment.status).toBe('COMPLETED');
            expect(result.walletDebit.ledgerEntryId).toBe('ledger-001');

            // Verify status updates
            expect(mockPaymentService.updatePaymentStatus).toHaveBeenCalledTimes(2);
            expect(mockPaymentService.updatePaymentStatus).toHaveBeenNthCalledWith(
                1,
                'payment-001',
                'PROCESSING'
            );
            expect(mockPaymentService.updatePaymentStatus).toHaveBeenNthCalledWith(
                2,
                'payment-001',
                'COMPLETED',
                expect.objectContaining({
                    gatewayTransactionId: 'ledger-001'
                })
            );

            // Verify wallet debit
            expect(mockWalletClient.debitWallet).toHaveBeenCalledWith({
                walletId: 'wallet-abc',
                amount: 1000,
                paymentId: 'payment-001',
                description: 'Test payment'
            });
        });

        test('should handle duplicate wallet debit (idempotent)', async () => {
            const payment = {
                id: 'payment-002',
                userId: 'user-123',
                amount: 2000,
                status: 'PENDING'
            };

            mockPaymentService.updatePaymentStatus.mockResolvedValueOnce({
                ...payment,
                status: 'PROCESSING'
            });

            // Mock: Wallet debit returns duplicate (already processed)
            mockWalletClient.debitWallet.mockResolvedValueOnce({
                success: true,
                balance: 8000,
                ledgerEntryId: 'ledger-002',
                duplicate: true  // Idempotent response
            });

            mockPaymentService.updatePaymentStatus.mockResolvedValueOnce({
                ...payment,
                status: 'COMPLETED'
            });

            const result = await paymentProcessor.processPayment(payment, 'wallet-abc');

            expect(result.success).toBe(true);
            expect(result.walletDebit.duplicate).toBe(true);
        });
    });

    describe('processPayment - Retry Logic', () => {
        test('should retry on network error and succeed on second attempt', async () => {
            const payment = {
                id: 'payment-003',
                userId: 'user-123',
                amount: 3000,
                status: 'PENDING'
            };

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'PROCESSING'
            });

            // Mock: First attempt fails with network error
            mockWalletClient.debitWallet
                .mockRejectedValueOnce(new Error('WALLET_SERVICE_UNAVAILABLE'))
                .mockResolvedValueOnce({
                    success: true,
                    balance: 7000,
                    ledgerEntryId: 'ledger-003',
                    duplicate: false
                });

            mockPaymentService.updatePaymentStatus.mockResolvedValueOnce({
                ...payment,
                status: 'COMPLETED'
            });

            const result = await paymentProcessor.processPayment(payment, 'wallet-abc');

            // Should succeed after retry
            expect(result.success).toBe(true);
            expect(mockWalletClient.debitWallet).toHaveBeenCalledTimes(2);
        });

        test('should retry up to max attempts on network errors', async () => {
            const payment = {
                id: 'payment-004',
                userId: 'user-123',
                amount: 4000,
                status: 'PENDING'
            };

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'PROCESSING'
            });

            // Mock: All attempts fail with network error
            mockWalletClient.debitWallet.mockRejectedValue(
                new Error('WALLET_SERVICE_UNAVAILABLE')
            );

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'FAILED'
            });

            mockPaymentService.getPayment.mockResolvedValue({
                ...payment,
                status: 'FAILED'
            });

            const result = await paymentProcessor.processPayment(payment, 'wallet-abc');

            // Should fail after max retries
            expect(result.success).toBe(false);
            expect(mockWalletClient.debitWallet).toHaveBeenCalledTimes(3); // Max retries

            // Should update status to FAILED
            expect(mockPaymentService.updatePaymentStatus).toHaveBeenCalledWith(
                'payment-004',
                'FAILED',
                expect.objectContaining({
                    failureReason: 'WALLET_SERVICE_UNAVAILABLE'
                })
            );
        });

        test('should succeed on third attempt after two failures', async () => {
            const payment = {
                id: 'payment-005',
                userId: 'user-123',
                amount: 5000,
                status: 'PENDING'
            };

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'PROCESSING'
            });

            // Mock: First two attempts fail, third succeeds
            mockWalletClient.debitWallet
                .mockRejectedValueOnce(new Error('WALLET_SERVICE_UNAVAILABLE'))
                .mockRejectedValueOnce(new Error('WALLET_SERVICE_UNAVAILABLE'))
                .mockResolvedValueOnce({
                    success: true,
                    balance: 5000,
                    ledgerEntryId: 'ledger-005',
                    duplicate: false
                });

            mockPaymentService.updatePaymentStatus.mockResolvedValueOnce({
                ...payment,
                status: 'COMPLETED'
            });

            const result = await paymentProcessor.processPayment(payment, 'wallet-abc');

            expect(result.success).toBe(true);
            expect(mockWalletClient.debitWallet).toHaveBeenCalledTimes(3);
        });
    });

    describe('processPayment - Non-Retryable Errors', () => {
        test('should NOT retry on insufficient balance error', async () => {
            const payment = {
                id: 'payment-006',
                userId: 'user-123',
                amount: 10000,
                status: 'PENDING'
            };

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'PROCESSING'
            });

            // Mock: Insufficient balance (non-retryable)
            mockWalletClient.debitWallet.mockRejectedValue(
                new Error('WALLET_INSUFFICIENT_BALANCE')
            );

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'FAILED'
            });

            mockPaymentService.getPayment.mockResolvedValue({
                ...payment,
                status: 'FAILED',
                failureReason: 'WALLET_INSUFFICIENT_BALANCE'
            });

            const result = await paymentProcessor.processPayment(payment, 'wallet-abc');

            // Should fail immediately without retry
            expect(result.success).toBe(false);
            expect(result.error).toBe('WALLET_INSUFFICIENT_BALANCE');
            expect(mockWalletClient.debitWallet).toHaveBeenCalledTimes(1); // No retries
        });

        test('should NOT retry on wallet not found error', async () => {
            const payment = {
                id: 'payment-007',
                userId: 'user-123',
                amount: 7000,
                status: 'PENDING'
            };

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'PROCESSING'
            });

            mockWalletClient.debitWallet.mockRejectedValue(
                new Error('WALLET_NOT_FOUND')
            );

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'FAILED'
            });

            mockPaymentService.getPayment.mockResolvedValue({
                ...payment,
                status: 'FAILED'
            });

            const result = await paymentProcessor.processPayment(payment, 'wallet-abc');

            expect(result.success).toBe(false);
            expect(mockWalletClient.debitWallet).toHaveBeenCalledTimes(1);
        });

        test('should NOT retry on wallet not active error', async () => {
            const payment = {
                id: 'payment-008',
                userId: 'user-123',
                amount: 8000,
                status: 'PENDING'
            };

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'PROCESSING'
            });

            mockWalletClient.debitWallet.mockRejectedValue(
                new Error('WALLET_NOT_ACTIVE')
            );

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'FAILED'
            });

            mockPaymentService.getPayment.mockResolvedValue({
                ...payment,
                status: 'FAILED'
            });

            const result = await paymentProcessor.processPayment(payment, 'wallet-abc');

            expect(result.success).toBe(false);
            expect(mockWalletClient.debitWallet).toHaveBeenCalledTimes(1);
        });
    });

    describe('processPayment - Idempotency Key Usage', () => {
        test('should use payment ID as idempotency key', async () => {
            const payment = {
                id: 'payment-009',
                userId: 'user-123',
                amount: 9000,
                status: 'PENDING',
                description: 'Order #12345'
            };

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'PROCESSING'
            });

            mockWalletClient.debitWallet.mockResolvedValue({
                success: true,
                balance: 1000,
                ledgerEntryId: 'ledger-009',
                duplicate: false
            });

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'COMPLETED'
            });

            await paymentProcessor.processPayment(payment, 'wallet-abc');

            // Verify idempotency key format
            expect(mockWalletClient.debitWallet).toHaveBeenCalledWith(
                expect.objectContaining({
                    paymentId: 'payment-009'
                })
            );
        });
    });

    describe('processPayment - Exactly-Once Guarantee', () => {
        test('should ensure exactly-once wallet debit even with retries', async () => {
            const payment = {
                id: 'payment-010',
                userId: 'user-123',
                amount: 1000,
                status: 'PENDING'
            };

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'PROCESSING'
            });

            // Simulate: First attempt times out, but wallet debit actually succeeded
            // Second attempt returns duplicate (idempotent)
            mockWalletClient.debitWallet
                .mockRejectedValueOnce(new Error('WALLET_SERVICE_UNAVAILABLE'))
                .mockResolvedValueOnce({
                    success: true,
                    balance: 9000,
                    ledgerEntryId: 'ledger-010',
                    duplicate: true  // Same ledger entry, no double charge
                });

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'COMPLETED'
            });

            const result = await paymentProcessor.processPayment(payment, 'wallet-abc');

            // Payment succeeds
            expect(result.success).toBe(true);

            // Wallet debit was attempted twice
            expect(mockWalletClient.debitWallet).toHaveBeenCalledTimes(2);

            // But only one ledger entry was created (duplicate: true)
            expect(result.walletDebit.duplicate).toBe(true);
            expect(result.walletDebit.ledgerEntryId).toBe('ledger-010');
        });
    });

    describe('refundPayment', () => {
        test('should refund payment successfully', async () => {
            const payment = {
                id: 'payment-011',
                userId: 'user-123',
                amount: 1000,
                status: 'COMPLETED',
                description: 'Test payment'
            };

            mockWalletClient.creditWallet.mockResolvedValue({
                success: true,
                balance: 10000,
                ledgerEntryId: 'ledger-refund-001'
            });

            mockPaymentService.updatePaymentStatus.mockResolvedValue({
                ...payment,
                status: 'REFUNDED'
            });

            const result = await paymentProcessor.refundPayment(payment, 'wallet-abc');

            expect(result.success).toBe(true);
            expect(result.payment.status).toBe('REFUNDED');
            expect(result.walletCredit.ledgerEntryId).toBe('ledger-refund-001');

            // Verify credit wallet call
            expect(mockWalletClient.creditWallet).toHaveBeenCalledWith({
                walletId: 'wallet-abc',
                amount: 1000,
                paymentId: 'payment-011',
                description: 'Refund for Test payment'
            });
        });
    });

    describe('isRetryableError', () => {
        test('should identify retryable errors', () => {
            expect(
                paymentProcessor.isRetryableError(new Error('WALLET_SERVICE_UNAVAILABLE'))
            ).toBe(true);
        });

        test('should identify non-retryable errors', () => {
            expect(
                paymentProcessor.isRetryableError(new Error('WALLET_INSUFFICIENT_BALANCE'))
            ).toBe(false);

            expect(
                paymentProcessor.isRetryableError(new Error('WALLET_NOT_FOUND'))
            ).toBe(false);

            expect(
                paymentProcessor.isRetryableError(new Error('WALLET_NOT_ACTIVE'))
            ).toBe(false);
        });
    });
});
