# Database Schema Design Documentation

## Overview

This document explains the PostgreSQL schema design for the distributed payment processing system, focusing on **correctness guarantees**, **concurrency control**, and **double-spend prevention**.

---

## Table of Contents

1. [Payment Service Schema](#payment-service-schema)
2. [Wallet Service Schema](#wallet-service-schema)
3. [Transaction Guarantees](#transaction-guarantees)
4. [Concurrency Control](#concurrency-control)
5. [Double-Spend Prevention](#double-spend-prevention)
6. [Idempotency Enforcement](#idempotency-enforcement)
7. [Index Strategy](#index-strategy)
8. [Performance Considerations](#performance-considerations)

---

## Payment Service Schema

### Database: `payment_db`

### Tables

#### 1. `payments` - Core Payment Transactions

**Purpose**: Store all payment transactions with idempotency enforcement.

**Key Columns**:
- `id` (UUID): Primary identifier
- `user_id` (UUID): User making the payment
- `merchant_id` (VARCHAR): Merchant receiving payment
- `amount` (BIGINT): Amount in smallest currency unit (cents) - **avoids floating-point precision issues**
- `currency` (VARCHAR(3)): ISO 4217 currency code
- `status` (VARCHAR): Payment lifecycle state
- `idempotency_key` (VARCHAR): **CRITICAL** - Unique key to prevent duplicate payments
- `gateway_transaction_id` (VARCHAR): External payment gateway reference
- `retry_count` (INTEGER): Number of retry attempts
- `created_at`, `updated_at`, `processed_at`: Audit timestamps

**Constraints**:
```sql
-- Prevent duplicate payments
CONSTRAINT unique_idempotency_key UNIQUE (idempotency_key)

-- Ensure positive amounts
CHECK (amount > 0)

-- Valid status transitions
CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED'))

-- Valid currencies
CHECK (currency IN ('USD', 'EUR', 'GBP', 'INR', 'JPY'))
```

**Why BIGINT for amount?**
- Avoids floating-point precision errors (e.g., 0.1 + 0.2 != 0.3)
- Store in smallest unit: $10.50 → 1050 cents
- Perform integer arithmetic (exact)
- Convert to decimal only for display

**Status Flow**:
```
PENDING → PROCESSING → COMPLETED
                    ↘ FAILED
                    
COMPLETED → REFUNDED
Any State → CANCELLED
```

#### 2. `payment_events` - Audit Trail

**Purpose**: Immutable event log for all payment state changes.

**Key Features**:
- **Append-only**: No updates or deletes
- Complete audit trail for compliance
- Debugging and reconciliation
- Automatic logging via trigger

**Trigger**:
```sql
CREATE TRIGGER log_payment_status_change
    AFTER UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION log_payment_state_change();
```

#### 3. `idempotency_cache` - Fast Duplicate Detection

**Purpose**: Quick idempotency check with TTL.

**Key Features**:
- Cache successful responses
- TTL-based cleanup (24 hours)
- Faster than querying payments table
- Complementary to unique constraint

**Workflow**:
1. Check `idempotency_cache` first (fast)
2. If not found, check `payments` table (slower)
3. Cache result for future requests

---

## Wallet Service Schema

### Database: `wallet_db`

### Tables

#### 1. `wallets` - User Balances

**Purpose**: Store user wallet balances with concurrency control.

**Key Columns**:
- `id` (UUID): Primary identifier
- `user_id` (UUID): Wallet owner
- `currency` (VARCHAR(3)): Wallet currency
- `balance` (BIGINT): Current balance in smallest unit
- `version` (INTEGER): **Optimistic locking version**
- `status` (VARCHAR): ACTIVE, FROZEN, CLOSED

**Constraints**:
```sql
-- Prevent negative balances (CRITICAL for double-spend prevention)
CHECK (balance >= 0)

-- One wallet per user per currency
CONSTRAINT unique_user_currency UNIQUE (user_id, currency)

-- Valid status
CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED'))
```

**Optimistic Locking**:
```sql
-- Version incremented on every update
CREATE TRIGGER increment_version_on_update
    BEFORE UPDATE ON wallets
    FOR EACH ROW
    EXECUTE FUNCTION increment_wallet_version();
```

**Application-level check**:
```sql
UPDATE wallets
SET balance = balance - 1000, version = version + 1
WHERE id = ? AND version = ?  -- Check version hasn't changed
```

If version changed → concurrent update detected → retry

#### 2. `ledger_entries` - Append-Only Transaction Log

**Purpose**: Immutable double-entry ledger for all wallet operations.

**Key Columns**:
- `id` (UUID): Primary identifier
- `wallet_id` (UUID): Reference to wallet
- `transaction_type` (VARCHAR): DEBIT, CREDIT, REFUND, ADJUSTMENT
- `amount` (BIGINT): **Negative for debit, positive for credit**
- `balance_after` (BIGINT): Balance snapshot after transaction
- `idempotency_key` (VARCHAR): Prevent duplicate entries
- `reference_id` (UUID): Link to payment/refund
- `reference_type` (VARCHAR): Type of reference

**Constraints**:
```sql
-- Prevent duplicate ledger entries
CONSTRAINT unique_ledger_idempotency UNIQUE (idempotency_key)

-- Amount cannot be zero
CHECK (amount != 0)

-- Balance must be non-negative
CHECK (balance_after >= 0)
```

**Double-Entry Bookkeeping**:
- Every transaction creates a ledger entry
- Negative amount = debit (money out)
- Positive amount = credit (money in)
- `balance_after` provides point-in-time snapshot

**Example**:
```
Initial balance: 10000 cents ($100)
Debit 500 cents ($5):
  - amount: -500
  - balance_after: 9500

Credit 1000 cents ($10):
  - amount: 1000
  - balance_after: 10500
```

#### 3. `wallet_locks` - Distributed Locking

**Purpose**: Prevent concurrent modifications to same wallet.

**Key Features**:
- Row-level lock per wallet
- TTL-based automatic release
- Deadlock prevention

**Usage**:
```sql
-- Acquire lock
INSERT INTO wallet_locks (wallet_id, lock_holder, expires_at)
VALUES (?, ?, NOW() + INTERVAL '30 seconds')
ON CONFLICT (wallet_id) DO NOTHING;

-- If INSERT succeeds → lock acquired
-- If INSERT fails → lock already held
```

#### 4. `balance_snapshots` - Reconciliation

**Purpose**: Periodic balance snapshots for reporting and reconciliation.

**Key Features**:
- Daily/hourly snapshots
- Fast balance history queries
- Reconciliation: snapshot balance = sum of ledger entries

---

## Transaction Guarantees

### ACID Properties

#### 1. **Atomicity**
All operations in a transaction succeed or fail together.

**Example - Payment Processing**:
```sql
BEGIN;
  -- Debit user wallet
  UPDATE wallets SET balance = balance - 1000 WHERE id = ?;
  
  -- Create ledger entry
  INSERT INTO ledger_entries (...) VALUES (...);
  
  -- Update payment status
  UPDATE payments SET status = 'COMPLETED' WHERE id = ?;
COMMIT;
```

If any step fails → entire transaction rolls back.

#### 2. **Consistency**
Database remains in valid state after transaction.

**Enforced by**:
- CHECK constraints (balance >= 0)
- UNIQUE constraints (idempotency_key)
- Foreign keys
- Triggers

#### 3. **Isolation**
Concurrent transactions don't interfere.

**Isolation Levels**:

| Level | Dirty Read | Non-Repeatable Read | Phantom Read |
|-------|------------|---------------------|--------------|
| READ COMMITTED (default) | ❌ | ✅ | ✅ |
| REPEATABLE READ | ❌ | ❌ | ✅ |
| SERIALIZABLE | ❌ | ❌ | ❌ |

**Recommendation**: Use `REPEATABLE READ` for payment transactions.

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
  -- Payment logic
COMMIT;
```

#### 4. **Durability**
Committed transactions survive crashes.

**PostgreSQL guarantees**:
- Write-Ahead Logging (WAL)
- Synchronous commits
- Replication for high availability

---

## Concurrency Control

### Problem: Race Conditions

**Scenario**: Two concurrent requests try to debit the same wallet.

```
Wallet balance: $100

Request A: Debit $80
Request B: Debit $60

Without concurrency control:
  Both read balance = $100
  Both check: $100 >= amount ✓
  Both debit → Final balance: -$40 ❌ (DOUBLE SPEND!)
```

### Solution 1: Row-Level Locking (FOR UPDATE)

**Pessimistic Locking** - Lock row during transaction.

```sql
BEGIN;
  -- Lock wallet row (blocks other transactions)
  SELECT balance FROM wallets WHERE id = ? FOR UPDATE;
  
  -- Check balance
  IF balance >= amount THEN
    UPDATE wallets SET balance = balance - amount WHERE id = ?;
  END IF;
COMMIT;
```

**How it works**:
1. Request A acquires lock on wallet row
2. Request B waits for lock to be released
3. Request A completes → releases lock
4. Request B acquires lock → sees updated balance → fails (insufficient funds)

**Pros**:
- Strong consistency
- Simple to implement

**Cons**:
- Reduced concurrency (blocking)
- Potential deadlocks

### Solution 2: Optimistic Locking (Version Column)

**Optimistic Locking** - Detect conflicts at commit time.

```sql
-- Read current version
SELECT balance, version FROM wallets WHERE id = ?;

-- Update only if version hasn't changed
UPDATE wallets
SET balance = balance - amount, version = version + 1
WHERE id = ? AND version = ?;

-- If affected rows = 0 → version changed → retry
```

**How it works**:
1. Request A reads: balance=$100, version=5
2. Request B reads: balance=$100, version=5
3. Request A updates: version=6 ✓
4. Request B tries to update where version=5 → fails (version is now 6)
5. Request B retries with new version

**Pros**:
- Better concurrency (no blocking)
- No deadlocks

**Cons**:
- Requires retry logic
- More complex

### Solution 3: Stored Procedures (Recommended)

**Atomic operations** - All logic in database.

```sql
CREATE FUNCTION debit_wallet(
    p_wallet_id UUID,
    p_amount BIGINT,
    p_idempotency_key VARCHAR
) RETURNS BOOLEAN AS $$
BEGIN
    -- Check idempotency
    IF EXISTS (SELECT 1 FROM ledger_entries WHERE idempotency_key = p_idempotency_key) THEN
        RETURN TRUE;
    END IF;
    
    -- Lock wallet
    SELECT balance INTO v_balance FROM wallets WHERE id = p_wallet_id FOR UPDATE;
    
    -- Check balance
    IF v_balance < p_amount THEN
        RETURN FALSE;
    END IF;
    
    -- Update balance
    UPDATE wallets SET balance = balance - p_amount WHERE id = p_wallet_id;
    
    -- Create ledger entry
    INSERT INTO ledger_entries (...) VALUES (...);
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
```

**Pros**:
- Atomic operation
- Reduced network roundtrips
- Encapsulated logic

---

## Double-Spend Prevention

### Multi-Layer Defense

#### Layer 1: Database Constraints
```sql
-- Prevent negative balances
CHECK (balance >= 0)
```

If balance goes negative → transaction fails → rollback.

#### Layer 2: Row-Level Locking
```sql
SELECT balance FROM wallets WHERE id = ? FOR UPDATE;
```

Serialize access to wallet → one transaction at a time.

#### Layer 3: Idempotency Keys
```sql
CONSTRAINT unique_ledger_idempotency UNIQUE (idempotency_key)
```

Prevent duplicate ledger entries for same transaction.

#### Layer 4: Ledger Reconciliation
```sql
-- Verify: wallet balance = sum of ledger entries
SELECT 
    w.balance AS wallet_balance,
    COALESCE(SUM(l.amount), 0) AS ledger_balance
FROM wallets w
LEFT JOIN ledger_entries l ON l.wallet_id = w.id
WHERE w.id = ?
GROUP BY w.id;
```

If mismatch → data corruption → alert.

### Complete Workflow

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- 1. Check idempotency
IF EXISTS (SELECT 1 FROM ledger_entries WHERE idempotency_key = ?) THEN
    ROLLBACK;
    RETURN 'ALREADY_PROCESSED';
END IF;

-- 2. Lock wallet
SELECT balance, version INTO v_balance, v_version
FROM wallets
WHERE id = ? AND status = 'ACTIVE'
FOR UPDATE;

-- 3. Check sufficient balance
IF v_balance < amount THEN
    ROLLBACK;
    RETURN 'INSUFFICIENT_BALANCE';
END IF;

-- 4. Update balance
UPDATE wallets
SET balance = balance - amount,
    version = version + 1
WHERE id = ? AND version = v_version;

-- 5. Create ledger entry
INSERT INTO ledger_entries (
    wallet_id, amount, balance_after, idempotency_key
) VALUES (
    ?, -amount, v_balance - amount, ?
);

COMMIT;
RETURN 'SUCCESS';
```

---

## Idempotency Enforcement

### Why Idempotency?

**Problem**: Network failures can cause duplicate requests.

```
Client → Server: "Debit $50"
Server → Database: Success
Server → Client: (network timeout)
Client retries: "Debit $50" (duplicate!)
```

Without idempotency → $100 debited instead of $50.

### Implementation

#### 1. Unique Idempotency Key
```sql
CREATE UNIQUE INDEX idx_payments_idempotency_key 
    ON payments(idempotency_key);
```

**Client generates key**:
```javascript
const idempotencyKey = `payment_${userId}_${timestamp}_${uuid()}`;
```

#### 2. Check Before Insert
```sql
-- Check if already processed
SELECT * FROM payments WHERE idempotency_key = ?;

-- If found → return cached result
-- If not found → process payment
```

#### 3. Atomic Insert
```sql
INSERT INTO payments (id, idempotency_key, ...)
VALUES (?, ?, ...)
ON CONFLICT (idempotency_key) DO NOTHING;

-- If INSERT succeeds → process payment
-- If INSERT fails → already processed
```

#### 4. TTL-Based Cleanup
```sql
-- Delete old idempotency records (after 24 hours)
DELETE FROM idempotency_cache
WHERE expires_at < NOW();
```

---

## Index Strategy

### Payment Service Indexes

```sql
-- 1. Idempotency (CRITICAL)
CREATE UNIQUE INDEX idx_payments_idempotency_key ON payments(idempotency_key);

-- 2. User payment history
CREATE INDEX idx_payments_user_id ON payments(user_id, created_at DESC);

-- 3. Processing queue
CREATE INDEX idx_payments_status ON payments(status, created_at ASC)
WHERE status IN ('PENDING', 'PROCESSING');

-- 4. Gateway reconciliation
CREATE INDEX idx_payments_gateway_transaction_id ON payments(gateway_transaction_id)
WHERE gateway_transaction_id IS NOT NULL;
```

### Wallet Service Indexes

```sql
-- 1. User wallet lookup
CREATE INDEX idx_wallets_user_id ON wallets(user_id);

-- 2. Transaction history
CREATE INDEX idx_ledger_entries_wallet_id ON ledger_entries(wallet_id, created_at DESC);

-- 3. Idempotency
CREATE UNIQUE INDEX idx_ledger_idempotency ON ledger_entries(idempotency_key);
```

### Index Best Practices

1. **Unique indexes for constraints** (idempotency)
2. **Composite indexes for common queries** (user_id, created_at)
3. **Partial indexes for filtered queries** (WHERE status IN (...))
4. **Covering indexes for read-heavy queries**

---

## Performance Considerations

### 1. Connection Pooling
```javascript
const pool = new Pool({
    min: 2,
    max: 10,
    idleTimeoutMillis: 30000
});
```

### 2. Prepared Statements
```sql
PREPARE get_wallet AS
SELECT balance FROM wallets WHERE id = $1 FOR UPDATE;

EXECUTE get_wallet(wallet_id);
```

### 3. Batch Operations
```sql
-- Instead of N queries
INSERT INTO ledger_entries VALUES (...), (...), (...);
```

### 4. Read Replicas
- Write to primary
- Read from replicas
- Eventual consistency acceptable for reads

### 5. Partitioning (Future)
```sql
-- Partition ledger_entries by date
CREATE TABLE ledger_entries_2024_01 PARTITION OF ledger_entries
FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
```

---

## Summary

### Key Guarantees

✅ **Idempotency**: Unique constraints + idempotency keys  
✅ **Double-Spend Prevention**: Row-level locking + CHECK constraints  
✅ **Concurrency Control**: FOR UPDATE + optimistic locking  
✅ **Audit Trail**: Append-only ledger + event log  
✅ **Data Integrity**: Foreign keys + triggers + constraints  
✅ **ACID Compliance**: PostgreSQL transactions  

### Transaction Safety

| Operation | Isolation Level | Locking | Idempotency |
|-----------|----------------|---------|-------------|
| Create Payment | REPEATABLE READ | None | Unique key |
| Debit Wallet | REPEATABLE READ | FOR UPDATE | Ledger key |
| Credit Wallet | REPEATABLE READ | FOR UPDATE | Ledger key |
| Refund | REPEATABLE READ | FOR UPDATE | Both |

---

**Next Steps**: Implement application logic using these schemas! 🚀
