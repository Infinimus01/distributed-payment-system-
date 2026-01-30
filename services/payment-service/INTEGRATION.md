# Payment-Wallet Integration

## Overview

This document explains how the Payment Service integrates with the Wallet Service to ensure **exactly-once semantics** and **safe retries** without double-charging users.

## Architecture

```
┌─────────────────┐         ┌─────────────────┐
│ Payment Service │────────►│ Wallet Service  │
│                 │  HTTP   │                 │
│ - Create Payment│         │ - Debit Wallet  │
│ - Process       │         │ - Credit Wallet │
│ - Retry Logic   │         │ - Ledger        │
└─────────────────┘         └─────────────────┘
```

## Payment Processing Flow

### 1. Create Payment (Idempotent)

```bash
POST /payments
Headers: Idempotency-Key: payment_user123_order456
Body: {
  "userId": "user-123",
  "amount": 5000,
  "currency": "USD",
  "merchantId": "merchant-001"
}

Response: 201 Created
{
  "payment": {
    "id": "payment-abc123",
    "status": "PENDING"
  }
}
```

### 2. Process Payment (Debit Wallet)

```bash
POST /payments/payment-abc123/process
Body: {
  "walletId": "wallet-xyz789"
}

Flow:
  1. Update payment status: PENDING → PROCESSING
  2. Debit wallet (with retries)
  3. Update payment status: PROCESSING → COMPLETED or FAILED
```

## Exactly-Once Semantics

### Problem: Network Failures

```
Client              Payment Service         Wallet Service
  │                        │                       │
  ├─ POST /process ───────►│                       │
  │                        ├─ Debit wallet ───────►│
  │                        │                       ├─ Create ledger entry
  │                        │                       ├─ Update balance
  │                        │◄──────────────────────┤ (success)
  │◄───────────────────X   │                       │ (network timeout)
  │                        │                       │
  ├─ POST /process ───────►│ (retry)               │
  │                        ├─ Debit wallet ───────►│
  │                        │                       ├─ Check idempotency key
  │                        │                       ├─ Return existing ledger
  │◄───────────────────────┼───────────────────────┤ (duplicate: true)
  │  200 OK                │                       │
```

### Solution: Idempotency Keys

**Payment Service** uses `payment_{paymentId}` as idempotency key:

```javascript
await walletClient.debitWallet({
  walletId: 'wallet-xyz',
  amount: 5000,
  idempotencyKey: `payment_${paymentId}`,  // CRITICAL
  referenceId: paymentId,
  referenceType: 'PAYMENT'
});
```

**Wallet Service** checks idempotency:

```sql
-- Check if ledger entry already exists
SELECT * FROM ledger_entries WHERE idempotency_key = 'payment_abc123';

-- If exists → return existing entry (no new debit)
-- If not exists → create new ledger entry
```

**Result**: Same payment ID → same ledger entry → no double charge

## Retry Strategy

### Retryable vs Non-Retryable Errors

| Error | Retryable? | Reason |
|-------|-----------|--------|
| `WALLET_SERVICE_UNAVAILABLE` | ✅ Yes | Network/timeout, safe to retry |
| `WALLET_INSUFFICIENT_BALANCE` | ❌ No | Business error, won't succeed |
| `WALLET_NOT_FOUND` | ❌ No | Data error, won't succeed |
| `WALLET_NOT_ACTIVE` | ❌ No | Business rule, won't succeed |

### Exponential Backoff

```
Attempt 1: Immediate (0ms delay)
Attempt 2: 1 second delay
Attempt 3: 2 seconds delay
Max attempts: 3
```

### Code Implementation

```javascript
async debitWalletWithRetry(params) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await walletClient.debitWallet(params);
    } catch (error) {
      // Don't retry business errors
      if (!isRetryable(error)) {
        throw error;
      }
      
      // Don't retry if last attempt
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Wait before retry
      await sleep((attempt - 1) * 1000);
    }
  }
}
```

## Failure Handling

### Scenario 1: Insufficient Balance

```
Payment Status: PENDING → PROCESSING → FAILED
Failure Reason: "WALLET_INSUFFICIENT_BALANCE"
Wallet Debit: NOT attempted (failed validation)
Ledger Entry: NOT created
```

**Client Action**: User needs to add funds, then create new payment with new idempotency key.

### Scenario 2: Wallet Service Down (Max Retries)

```
Payment Status: PENDING → PROCESSING → FAILED
Failure Reason: "WALLET_SERVICE_UNAVAILABLE"
Wallet Debit: Attempted 3 times
Ledger Entry: NOT created (all attempts failed)
```

**Client Action**: Retry processing same payment (idempotent).

```bash
POST /payments/payment-abc123/process
Body: { "walletId": "wallet-xyz" }

# If wallet service is back up, will succeed
# If payment already completed, returns 200 OK with existing result
```

### Scenario 3: Timeout After Success

```
Timeline:
  T0: Payment service sends debit request
  T1: Wallet service creates ledger entry
  T2: Wallet service sends response
  T3: Network timeout (response lost)
  T4: Payment service retries
  T5: Wallet service returns duplicate (idempotent)
  T6: Payment marked as COMPLETED
```

**Result**: Only ONE ledger entry created, no double charge.

## API Examples

### Complete Flow

```bash
# 1. Create payment
curl -X POST http://localhost:3001/payments \
  -H "Idempotency-Key: payment_user123_order456" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-123",
    "amount": 5000,
    "currency": "USD",
    "merchantId": "merchant-001",
    "description": "Order #456"
  }'

# Response: 201 Created
{
  "success": true,
  "data": {
    "payment": {
      "id": "payment-abc123",
      "status": "PENDING",
      ...
    },
    "duplicate": false
  }
}

# 2. Process payment (debit wallet)
curl -X POST http://localhost:3001/payments/payment-abc123/process \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": "wallet-xyz789"
  }'

# Response: 200 OK (Success)
{
  "success": true,
  "data": {
    "payment": {
      "id": "payment-abc123",
      "status": "COMPLETED",
      "gatewayTransactionId": "ledger-001",
      "processedAt": "2024-01-30T10:05:00Z"
    },
    "walletDebit": {
      "balance": 5000,
      "ledgerEntryId": "ledger-001",
      "duplicate": false
    }
  }
}

# Response: 422 Unprocessable Entity (Failure)
{
  "success": false,
  "error": "PAYMENT_PROCESSING_FAILED",
  "message": "WALLET_INSUFFICIENT_BALANCE",
  "data": {
    "payment": {
      "id": "payment-abc123",
      "status": "FAILED",
      "failureReason": "WALLET_INSUFFICIENT_BALANCE"
    }
  }
}
```

### Refund Flow

```bash
# Refund completed payment
curl -X POST http://localhost:3001/payments/payment-abc123/refund \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": "wallet-xyz789"
  }'

# Response: 200 OK
{
  "success": true,
  "data": {
    "payment": {
      "id": "payment-abc123",
      "status": "REFUNDED",
      "processedAt": "2024-01-30T10:10:00Z"
    },
    "walletCredit": {
      "balance": 10000,
      "ledgerEntryId": "ledger-refund-001"
    }
  }
}
```

## Testing Retry Logic

### Test 1: Network Timeout

```javascript
// First attempt: timeout
// Second attempt: success (duplicate)
mockWalletClient.debitWallet
  .mockRejectedValueOnce(new Error('WALLET_SERVICE_UNAVAILABLE'))
  .mockResolvedValueOnce({
    success: true,
    ledgerEntryId: 'ledger-001',
    duplicate: true  // Same ledger entry
  });

const result = await processor.processPayment(payment, walletId);

expect(result.success).toBe(true);
expect(result.walletDebit.duplicate).toBe(true);
expect(mockWalletClient.debitWallet).toHaveBeenCalledTimes(2);
```

### Test 2: Insufficient Balance (No Retry)

```javascript
mockWalletClient.debitWallet.mockRejectedValue(
  new Error('WALLET_INSUFFICIENT_BALANCE')
);

const result = await processor.processPayment(payment, walletId);

expect(result.success).toBe(false);
expect(mockWalletClient.debitWallet).toHaveBeenCalledTimes(1); // No retry
```

## Monitoring & Observability

### Key Metrics

1. **Retry Rate**: % of payments requiring retries
2. **Success After Retry**: % of retries that succeed
3. **Duplicate Rate**: % of wallet debits returning duplicate
4. **Failure Reasons**: Distribution of failure types

### Logs

```json
{
  "level": "info",
  "message": "Wallet debit attempt",
  "attempt": 2,
  "maxRetries": 3,
  "paymentId": "payment-abc123"
}

{
  "level": "info",
  "message": "Wallet debit succeeded after retry",
  "attempt": 2,
  "paymentId": "payment-abc123",
  "duplicate": true
}
```

## Guarantees

✅ **Exactly-Once**: Same payment → same ledger entry  
✅ **No Double Charge**: Idempotency prevents duplicates  
✅ **Safe Retries**: Network failures can be retried  
✅ **Audit Trail**: All attempts logged  
✅ **Status Tracking**: Payment status reflects current state  

## License

MIT
