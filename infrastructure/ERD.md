# Database Schema - Entity Relationship Diagram

## Payment Service (payment_db)

```
┌─────────────────────────────────────────────────────────────┐
│                         PAYMENTS                            │
├─────────────────────────────────────────────────────────────┤
│ PK  id                    UUID                              │
│     user_id               UUID                              │
│     merchant_id           VARCHAR(255)                      │
│     amount                BIGINT          CHECK (> 0)       │
│     currency              VARCHAR(3)                        │
│     status                VARCHAR(20)                       │
│ UK  idempotency_key       VARCHAR(255)    UNIQUE ⚡         │
│     description           TEXT                              │
│     metadata              JSONB                             │
│     gateway_transaction_id VARCHAR(255)                     │
│     failure_reason        TEXT                              │
│     retry_count           INTEGER                           │
│     created_at            TIMESTAMPTZ                       │
│     updated_at            TIMESTAMPTZ                       │
│     processed_at          TIMESTAMPTZ                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ 1:N
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     PAYMENT_EVENTS                          │
├─────────────────────────────────────────────────────────────┤
│ PK  id                    UUID                              │
│ FK  payment_id            UUID          → payments.id       │
│     event_type            VARCHAR(50)                       │
│     previous_status       VARCHAR(20)                       │
│     new_status            VARCHAR(20)                       │
│     actor_id              VARCHAR(255)                      │
│     actor_type            VARCHAR(50)                       │
│     metadata              JSONB                             │
│     created_at            TIMESTAMPTZ   (immutable)         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                  IDEMPOTENCY_CACHE                          │
├─────────────────────────────────────────────────────────────┤
│ PK  idempotency_key       VARCHAR(255)                      │
│ FK  payment_id            UUID          → payments.id       │
│     response_payload      JSONB                             │
│     response_status_code  INTEGER                           │
│     created_at            TIMESTAMPTZ                       │
│     expires_at            TIMESTAMPTZ   (TTL)               │
└─────────────────────────────────────────────────────────────┘
```

## Wallet Service (wallet_db)

```
┌─────────────────────────────────────────────────────────────┐
│                         WALLETS                             │
├─────────────────────────────────────────────────────────────┤
│ PK  id                    UUID                              │
│     user_id               UUID                              │
│     currency              VARCHAR(3)                        │
│     balance               BIGINT          CHECK (>= 0) ⚡   │
│     version               INTEGER         (optimistic lock) │
│     status                VARCHAR(20)                       │
│     metadata              JSONB                             │
│     created_at            TIMESTAMPTZ                       │
│     updated_at            TIMESTAMPTZ                       │
│                                                             │
│ UK  (user_id, currency)   UNIQUE                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ 1:N
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    LEDGER_ENTRIES                           │
├─────────────────────────────────────────────────────────────┤
│ PK  id                    UUID                              │
│ FK  wallet_id             UUID          → wallets.id        │
│     transaction_type      VARCHAR(20)                       │
│     amount                BIGINT          (- debit, + credit)│
│     balance_after         BIGINT          CHECK (>= 0)      │
│     currency              VARCHAR(3)                        │
│     reference_id          UUID                              │
│     reference_type        VARCHAR(50)                       │
│ UK  idempotency_key       VARCHAR(255)   UNIQUE ⚡          │
│     description           TEXT                              │
│     metadata              JSONB                             │
│     created_at            TIMESTAMPTZ    (immutable)        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     WALLET_LOCKS                            │
├─────────────────────────────────────────────────────────────┤
│ PK  wallet_id             UUID          → wallets.id        │
│     lock_holder           VARCHAR(255)                      │
│     locked_by             VARCHAR(255)                      │
│     lock_reason           VARCHAR(255)                      │
│     acquired_at           TIMESTAMPTZ                       │
│     expires_at            TIMESTAMPTZ    (TTL)              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                  BALANCE_SNAPSHOTS                          │
├─────────────────────────────────────────────────────────────┤
│ PK  id                    UUID                              │
│ FK  wallet_id             UUID          → wallets.id        │
│     balance               BIGINT                            │
│     currency              VARCHAR(3)                        │
│     snapshot_type         VARCHAR(20)                       │
│     snapshot_at           TIMESTAMPTZ                       │
│     created_at            TIMESTAMPTZ                       │
│                                                             │
│ UK  (wallet_id, snapshot_type, snapshot_at) UNIQUE          │
└─────────────────────────────────────────────────────────────┘
```

## Cross-Service Relationships

```
┌──────────────────┐                    ┌──────────────────┐
│  PAYMENT SERVICE │                    │  WALLET SERVICE  │
│   (payment_db)   │                    │   (wallet_db)    │
└──────────────────┘                    └──────────────────┘
         │                                       │
         │                                       │
         ▼                                       ▼
  ┌─────────────┐                        ┌─────────────┐
  │  payments   │                        │   wallets   │
  │             │                        │             │
  │ reference_id├───────────────────────►│     id      │
  │             │   (application-level)  │             │
  └─────────────┘                        └─────────────┘
         │                                       │
         │                                       │
         ▼                                       ▼
  ┌─────────────┐                        ┌─────────────┐
  │payment_events│                       │ledger_entries│
  │             │                        │             │
  │ reference_id├───────────────────────►│ reference_id│
  │             │   (payment_id)         │             │
  └─────────────┘                        └─────────────┘
```

## Key Symbols

- **PK**: Primary Key
- **FK**: Foreign Key
- **UK**: Unique Constraint
- **⚡**: CRITICAL for correctness
- **→**: Foreign key reference
- **1:N**: One-to-many relationship

## Critical Constraints

### Idempotency (⚡)
```sql
-- Prevents duplicate payments
UNIQUE (payments.idempotency_key)

-- Prevents duplicate ledger entries
UNIQUE (ledger_entries.idempotency_key)
```

### Double-Spend Prevention (⚡)
```sql
-- Prevents negative balances
CHECK (wallets.balance >= 0)
CHECK (ledger_entries.balance_after >= 0)

-- One wallet per user per currency
UNIQUE (wallets.user_id, wallets.currency)
```

### Data Integrity
```sql
-- Valid payment status
CHECK (payments.status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED'))

-- Valid transaction type
CHECK (ledger_entries.transaction_type IN ('DEBIT', 'CREDIT', 'REFUND', 'ADJUSTMENT'))

-- Positive amounts
CHECK (payments.amount > 0)

-- Non-zero ledger amounts
CHECK (ledger_entries.amount != 0)
```

## Indexes Overview

### Payment Service
```
payments:
  - PRIMARY KEY (id)
  - UNIQUE (idempotency_key) ⚡
  - INDEX (user_id, created_at DESC)
  - INDEX (status, created_at ASC) WHERE status IN ('PENDING', 'PROCESSING')
  - INDEX (gateway_transaction_id) WHERE gateway_transaction_id IS NOT NULL
  - INDEX (merchant_id, status, created_at DESC)
  - INDEX (created_at DESC)

payment_events:
  - PRIMARY KEY (id)
  - INDEX (payment_id, created_at ASC)
  - INDEX (event_type, created_at DESC)

idempotency_cache:
  - PRIMARY KEY (idempotency_key)
  - INDEX (expires_at) WHERE expires_at < NOW()
```

### Wallet Service
```
wallets:
  - PRIMARY KEY (id)
  - UNIQUE (user_id, currency)
  - INDEX (user_id)
  - INDEX (status) WHERE status = 'ACTIVE'

ledger_entries:
  - PRIMARY KEY (id)
  - UNIQUE (idempotency_key) ⚡
  - INDEX (wallet_id, created_at DESC)
  - INDEX (reference_type, reference_id)
  - INDEX (created_at DESC)
  - INDEX (wallet_id, transaction_type, created_at DESC)

wallet_locks:
  - PRIMARY KEY (wallet_id)
  - INDEX (expires_at) WHERE expires_at < NOW()

balance_snapshots:
  - PRIMARY KEY (id)
  - UNIQUE (wallet_id, snapshot_type, snapshot_at)
  - INDEX (wallet_id, snapshot_at DESC)
  - INDEX (snapshot_at DESC)
```

## Stored Procedures

### Wallet Service

#### `debit_wallet()`
```sql
debit_wallet(
    p_wallet_id UUID,
    p_amount BIGINT,
    p_idempotency_key VARCHAR,
    p_reference_id UUID,
    p_reference_type VARCHAR,
    p_description TEXT
) RETURNS BOOLEAN
```

**Guarantees**:
- ✅ Idempotency check
- ✅ Row-level locking (FOR UPDATE)
- ✅ Balance validation
- ✅ Atomic update + ledger entry
- ✅ Returns FALSE if insufficient balance

#### `credit_wallet()`
```sql
credit_wallet(
    p_wallet_id UUID,
    p_amount BIGINT,
    p_idempotency_key VARCHAR,
    p_reference_id UUID,
    p_reference_type VARCHAR,
    p_description TEXT
) RETURNS BOOLEAN
```

**Guarantees**:
- ✅ Idempotency check
- ✅ Row-level locking (FOR UPDATE)
- ✅ Atomic update + ledger entry

## Triggers

### Payment Service
1. **`update_payments_updated_at`** - Auto-update `updated_at` timestamp
2. **`log_payment_status_change`** - Auto-log status changes to `payment_events`

### Wallet Service
1. **`update_wallets_updated_at`** - Auto-update `updated_at` timestamp
2. **`increment_version_on_update`** - Auto-increment version for optimistic locking

## Transaction Patterns

### Pattern 1: Create Payment
```
BEGIN TRANSACTION
  ├─ Check idempotency_cache
  ├─ INSERT INTO payments
  ├─ INSERT INTO idempotency_cache
  └─ COMMIT
```

### Pattern 2: Process Payment
```
BEGIN TRANSACTION (REPEATABLE READ)
  ├─ SELECT payment FOR UPDATE
  ├─ UPDATE payment status = 'PROCESSING'
  ├─ Call external payment gateway
  ├─ debit_wallet() → wallet service
  ├─ UPDATE payment status = 'COMPLETED'
  └─ COMMIT
```

### Pattern 3: Debit Wallet (Stored Procedure)
```
BEGIN TRANSACTION (REPEATABLE READ)
  ├─ Check ledger idempotency
  ├─ SELECT wallet FOR UPDATE (lock)
  ├─ Validate balance >= amount
  ├─ UPDATE wallet balance
  ├─ INSERT INTO ledger_entries
  └─ COMMIT
```

---

**Legend**:
- ⚡ = CRITICAL for system correctness
- → = Foreign key relationship
- 1:N = One-to-many relationship
- UK = Unique constraint
- PK = Primary key
- FK = Foreign key
