const WalletService = require('../../src/services/WalletService');

describe('WalletService - Debit Logic', () => {
    let walletService;
    let mockWalletRepo;
    let mockLedgerRepo;
    let mockDb;
    let mockClient;

    beforeEach(() => {
        // Mock client for transactions
        mockClient = {
            query: jest.fn()
        };

        // Mock database client
        mockDb = {
            transaction: jest.fn(async (callback) => {
                return await callback(mockClient);
            }),
            query: jest.fn()
        };

        // Mock wallet repository
        mockWalletRepo = {
            findById: jest.fn(),
            updateBalance: jest.fn(),
            create: jest.fn(),
            findByUserIdAndCurrency: jest.fn()
        };

        // Mock ledger repository
        mockLedgerRepo = {
            findByIdempotencyKey: jest.fn(),
            create: jest.fn(),
            existsByIdempotencyKey: jest.fn()
        };

        walletService = new WalletService(mockWalletRepo, mockLedgerRepo, mockDb);
    });

    describe('debitWallet - Success Cases', () => {
        test('should successfully debit wallet with sufficient balance', async () => {
            const walletId = 'wallet-123';
            const amount = 500;
            const idempotencyKey = 'debit-001';

            // Mock: No existing ledger entry (not a duplicate)
            mockLedgerRepo.findByIdempotencyKey.mockResolvedValue(null);

            // Mock: Wallet exists with sufficient balance
            const mockWallet = {
                id: walletId,
                userId: 'user-123',
                currency: 'USD',
                balance: 1000,
                version: 1,
                status: 'ACTIVE'
            };
            mockWalletRepo.findById.mockResolvedValue(mockWallet);

            // Mock: Balance update succeeds
            const updatedWallet = {
                ...mockWallet,
                balance: 500,
                version: 2
            };
            mockWalletRepo.updateBalance.mockResolvedValue(updatedWallet);

            // Mock: Ledger entry created
            const mockLedgerEntry = {
                id: 'ledger-001',
                walletId,
                transactionType: 'DEBIT',
                amount: -500,
                balanceAfter: 500,
                currency: 'USD',
                idempotencyKey,
                createdAt: new Date()
            };
            mockLedgerRepo.create.mockResolvedValue(mockLedgerEntry);

            // Execute
            const result = await walletService.debitWallet({
                walletId,
                amount,
                idempotencyKey,
                referenceId: 'payment-123',
                referenceType: 'PAYMENT',
                description: 'Test debit'
            });

            // Assertions
            expect(result.success).toBe(true);
            expect(result.wallet.balance).toBe(500);
            expect(result.wallet.version).toBe(2);
            expect(result.ledgerEntry.amount).toBe(-500);
            expect(result.duplicate).toBe(false);

            // Verify transaction was used
            expect(mockDb.transaction).toHaveBeenCalledTimes(1);

            // Verify wallet was locked (forUpdate: true)
            expect(mockWalletRepo.findById).toHaveBeenCalledWith(
                walletId,
                expect.objectContaining({ forUpdate: true })
            );

            // Verify balance was updated with correct version
            expect(mockWalletRepo.updateBalance).toHaveBeenCalledWith(
                walletId,
                500,
                1,
                mockClient
            );

            // Verify ledger entry was created
            expect(mockLedgerRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    walletId,
                    transactionType: 'DEBIT',
                    amount: -500,
                    balanceAfter: 500,
                    idempotencyKey
                }),
                mockClient
            );
        });

        test('should handle idempotent request (duplicate)', async () => {
            const walletId = 'wallet-123';
            const amount = 500;
            const idempotencyKey = 'debit-001';

            // Mock: Existing ledger entry found (duplicate request)
            const existingLedgerEntry = {
                id: 'ledger-001',
                walletId,
                transactionType: 'DEBIT',
                amount: -500,
                balanceAfter: 500,
                idempotencyKey
            };
            mockLedgerRepo.findByIdempotencyKey.mockResolvedValue(existingLedgerEntry);

            // Mock: Current wallet state
            const mockWallet = {
                id: walletId,
                balance: 500,
                version: 2
            };
            mockWalletRepo.findById.mockResolvedValue(mockWallet);

            // Execute
            const result = await walletService.debitWallet({
                walletId,
                amount,
                idempotencyKey
            });

            // Assertions
            expect(result.success).toBe(true);
            expect(result.duplicate).toBe(true);
            expect(result.ledgerEntry.id).toBe('ledger-001');

            // Verify no balance update occurred
            expect(mockWalletRepo.updateBalance).not.toHaveBeenCalled();

            // Verify no new ledger entry was created
            expect(mockLedgerRepo.create).not.toHaveBeenCalled();
        });

        test('should debit exact balance (edge case)', async () => {
            const walletId = 'wallet-123';
            const amount = 1000;
            const idempotencyKey = 'debit-002';

            mockLedgerRepo.findByIdempotencyKey.mockResolvedValue(null);

            const mockWallet = {
                id: walletId,
                balance: 1000,
                version: 1,
                status: 'ACTIVE'
            };
            mockWalletRepo.findById.mockResolvedValue(mockWallet);

            const updatedWallet = {
                ...mockWallet,
                balance: 0,
                version: 2
            };
            mockWalletRepo.updateBalance.mockResolvedValue(updatedWallet);

            const mockLedgerEntry = {
                id: 'ledger-002',
                amount: -1000,
                balanceAfter: 0
            };
            mockLedgerRepo.create.mockResolvedValue(mockLedgerEntry);

            const result = await walletService.debitWallet({
                walletId,
                amount,
                idempotencyKey
            });

            expect(result.success).toBe(true);
            expect(result.wallet.balance).toBe(0);
            expect(mockWalletRepo.updateBalance).toHaveBeenCalledWith(
                walletId,
                0,
                1,
                mockClient
            );
        });
    });

    describe('debitWallet - Failure Cases', () => {
        test('should throw error for insufficient balance', async () => {
            const walletId = 'wallet-123';
            const amount = 1500;
            const idempotencyKey = 'debit-003';

            mockLedgerRepo.findByIdempotencyKey.mockResolvedValue(null);

            const mockWallet = {
                id: walletId,
                balance: 1000,
                version: 1,
                status: 'ACTIVE'
            };
            mockWalletRepo.findById.mockResolvedValue(mockWallet);

            await expect(
                walletService.debitWallet({
                    walletId,
                    amount,
                    idempotencyKey
                })
            ).rejects.toThrow('INSUFFICIENT_BALANCE');

            // Verify no balance update occurred
            expect(mockWalletRepo.updateBalance).not.toHaveBeenCalled();
            expect(mockLedgerRepo.create).not.toHaveBeenCalled();
        });

        test('should throw error for wallet not found', async () => {
            const walletId = 'non-existent';
            const amount = 500;
            const idempotencyKey = 'debit-004';

            mockLedgerRepo.findByIdempotencyKey.mockResolvedValue(null);
            mockWalletRepo.findById.mockResolvedValue(null);

            await expect(
                walletService.debitWallet({
                    walletId,
                    amount,
                    idempotencyKey
                })
            ).rejects.toThrow('WALLET_NOT_FOUND');
        });

        test('should throw error for inactive wallet', async () => {
            const walletId = 'wallet-123';
            const amount = 500;
            const idempotencyKey = 'debit-005';

            mockLedgerRepo.findByIdempotencyKey.mockResolvedValue(null);

            const mockWallet = {
                id: walletId,
                balance: 1000,
                version: 1,
                status: 'FROZEN'
            };
            mockWalletRepo.findById.mockResolvedValue(mockWallet);

            await expect(
                walletService.debitWallet({
                    walletId,
                    amount,
                    idempotencyKey
                })
            ).rejects.toThrow('WALLET_NOT_ACTIVE');
        });

        test('should throw error for missing walletId', async () => {
            await expect(
                walletService.debitWallet({
                    amount: 500,
                    idempotencyKey: 'debit-006'
                })
            ).rejects.toThrow('INVALID_INPUT: walletId is required');
        });

        test('should throw error for missing amount', async () => {
            await expect(
                walletService.debitWallet({
                    walletId: 'wallet-123',
                    idempotencyKey: 'debit-007'
                })
            ).rejects.toThrow('INVALID_INPUT: amount must be greater than 0');
        });

        test('should throw error for negative amount', async () => {
            await expect(
                walletService.debitWallet({
                    walletId: 'wallet-123',
                    amount: -500,
                    idempotencyKey: 'debit-008'
                })
            ).rejects.toThrow('INVALID_INPUT: amount must be greater than 0');
        });

        test('should throw error for zero amount', async () => {
            await expect(
                walletService.debitWallet({
                    walletId: 'wallet-123',
                    amount: 0,
                    idempotencyKey: 'debit-009'
                })
            ).rejects.toThrow('INVALID_INPUT: amount must be greater than 0');
        });

        test('should throw error for missing idempotencyKey', async () => {
            await expect(
                walletService.debitWallet({
                    walletId: 'wallet-123',
                    amount: 500
                })
            ).rejects.toThrow('INVALID_INPUT: idempotencyKey is required');
        });
    });

    describe('debitWallet - Concurrency Control', () => {
        test('should handle concurrent modification error', async () => {
            const walletId = 'wallet-123';
            const amount = 500;
            const idempotencyKey = 'debit-010';

            mockLedgerRepo.findByIdempotencyKey.mockResolvedValue(null);

            const mockWallet = {
                id: walletId,
                balance: 1000,
                version: 1,
                status: 'ACTIVE'
            };
            mockWalletRepo.findById.mockResolvedValue(mockWallet);

            // Simulate concurrent modification (version changed)
            mockWalletRepo.updateBalance.mockRejectedValue(
                new Error('CONCURRENT_MODIFICATION')
            );

            await expect(
                walletService.debitWallet({
                    walletId,
                    amount,
                    idempotencyKey
                })
            ).rejects.toThrow('CONCURRENT_MODIFICATION');
        });

        test('should use row-level locking (FOR UPDATE)', async () => {
            const walletId = 'wallet-123';
            const amount = 500;
            const idempotencyKey = 'debit-011';

            mockLedgerRepo.findByIdempotencyKey.mockResolvedValue(null);

            const mockWallet = {
                id: walletId,
                balance: 1000,
                version: 1,
                status: 'ACTIVE'
            };
            mockWalletRepo.findById.mockResolvedValue(mockWallet);

            const updatedWallet = { ...mockWallet, balance: 500, version: 2 };
            mockWalletRepo.updateBalance.mockResolvedValue(updatedWallet);

            const mockLedgerEntry = {
                id: 'ledger-011',
                amount: -500,
                balanceAfter: 500
            };
            mockLedgerRepo.create.mockResolvedValue(mockLedgerEntry);

            await walletService.debitWallet({
                walletId,
                amount,
                idempotencyKey
            });

            // Verify forUpdate was set to true
            expect(mockWalletRepo.findById).toHaveBeenCalledWith(
                walletId,
                expect.objectContaining({ forUpdate: true, client: mockClient })
            );
        });
    });

    describe('debitWallet - Transaction Rollback', () => {
        test('should rollback transaction on error', async () => {
            const walletId = 'wallet-123';
            const amount = 500;
            const idempotencyKey = 'debit-012';

            mockLedgerRepo.findByIdempotencyKey.mockResolvedValue(null);

            const mockWallet = {
                id: walletId,
                balance: 1000,
                version: 1,
                status: 'ACTIVE'
            };
            mockWalletRepo.findById.mockResolvedValue(mockWallet);

            const updatedWallet = { ...mockWallet, balance: 500, version: 2 };
            mockWalletRepo.updateBalance.mockResolvedValue(updatedWallet);

            // Simulate ledger creation failure
            mockLedgerRepo.create.mockRejectedValue(new Error('Database error'));

            await expect(
                walletService.debitWallet({
                    walletId,
                    amount,
                    idempotencyKey
                })
            ).rejects.toThrow('Database error');

            // Transaction should have been called (and rolled back internally)
            expect(mockDb.transaction).toHaveBeenCalled();
        });
    });

    describe('debitWallet - Ledger Entry Creation', () => {
        test('should create ledger entry with correct negative amount', async () => {
            const walletId = 'wallet-123';
            const amount = 500;
            const idempotencyKey = 'debit-013';

            mockLedgerRepo.findByIdempotencyKey.mockResolvedValue(null);

            const mockWallet = {
                id: walletId,
                userId: 'user-123',
                currency: 'USD',
                balance: 1000,
                version: 1,
                status: 'ACTIVE'
            };
            mockWalletRepo.findById.mockResolvedValue(mockWallet);

            const updatedWallet = { ...mockWallet, balance: 500, version: 2 };
            mockWalletRepo.updateBalance.mockResolvedValue(updatedWallet);

            const mockLedgerEntry = {
                id: 'ledger-013',
                amount: -500,
                balanceAfter: 500
            };
            mockLedgerRepo.create.mockResolvedValue(mockLedgerEntry);

            await walletService.debitWallet({
                walletId,
                amount,
                idempotencyKey,
                referenceId: 'payment-123',
                referenceType: 'PAYMENT',
                description: 'Payment debit'
            });

            expect(mockLedgerRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    walletId,
                    transactionType: 'DEBIT',
                    amount: -500, // Negative for debit
                    balanceAfter: 500,
                    currency: 'USD',
                    referenceId: 'payment-123',
                    referenceType: 'PAYMENT',
                    idempotencyKey,
                    description: 'Payment debit'
                }),
                mockClient
            );
        });
    });
});
