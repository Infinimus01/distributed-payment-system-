# Wallet Service

Production-grade wallet and balance management service with transactional guarantees.

## Features

- ✅ **Create Wallet** - Initialize user wallets with currency support
- ✅ **Debit Wallet** - Withdraw money with atomic transaction
- ✅ **Credit Wallet** - Add money with idempotency
- ✅ **Transaction History** - View ledger entries
- ✅ **Balance Reconciliation** - Verify wallet vs ledger balance

## Architecture

### Layers
- **Controllers** - HTTP request handlers
- **Services** - Business logic
- **Repositories** - Data access layer
- **Infrastructure** - Database client

### Key Features
- **Transactional Safety** - All operations run in DB transactions
- **Row-Level Locking** - `FOR UPDATE` prevents concurrent modifications
- **Optimistic Locking** - Version column detects conflicts
- **Idempotency** - Duplicate requests return same result
- **Negative Balance Prevention** - CHECK constraint + balance validation
- **Append-Only Ledger** - Complete audit trail

## API Endpoints

### POST /wallets/create
Create a new wallet for a user.

**Request:**
```json
{
  "userId": "user-123",
  "currency": "USD",
  "initialBalance": 10000
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "wallet": {
      "id": "wallet-abc",
      "userId": "user-123",
      "currency": "USD",
      "balance": 10000,
      "status": "ACTIVE",
      "createdAt": "2024-01-30T10:00:00Z"
    }
  }
}
```

### POST /wallets/debit
Debit money from wallet (atomic transaction).

**Request:**
```json
{
  "walletId": "wallet-abc",
  "amount": 500,
  "idempotencyKey": "debit_payment_123",
  "referenceId": "payment-123",
  "referenceType": "PAYMENT",
  "description": "Payment for order #123"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "wallet": {
      "id": "wallet-abc",
      "balance": 9500,
      "version": 2
    },
    "ledgerEntry": {
      "id": "ledger-xyz",
      "amount": -500,
      "balanceAfter": 9500,
      "createdAt": "2024-01-30T10:05:00Z"
    },
    "duplicate": false
  }
}
```

**Error Response (Insufficient Balance):**
```json
{
  "success": false,
  "error": "INSUFFICIENT_BALANCE",
  "message": "Insufficient balance"
}
```

### POST /wallets/credit
Credit money to wallet.

**Request:**
```json
{
  "walletId": "wallet-abc",
  "amount": 1000,
  "idempotencyKey": "credit_refund_456",
  "referenceId": "refund-456",
  "referenceType": "REFUND",
  "description": "Refund for order #456"
}
```

### GET /wallets/:walletId
Get wallet details.

**Response:**
```json
{
  "success": true,
  "data": {
    "wallet": {
      "id": "wallet-abc",
      "userId": "user-123",
      "currency": "USD",
      "balance": 10500,
      "status": "ACTIVE",
      "version": 3,
      "createdAt": "2024-01-30T10:00:00Z",
      "updatedAt": "2024-01-30T10:10:00Z"
    }
  }
}
```

### GET /wallets/:walletId/transactions
Get transaction history.

**Query Parameters:**
- `limit` (default: 50)
- `offset` (default: 0)

**Response:**
```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "id": "ledger-xyz",
        "transactionType": "DEBIT",
        "amount": -500,
        "balanceAfter": 9500,
        "referenceId": "payment-123",
        "referenceType": "PAYMENT",
        "description": "Payment for order #123",
        "createdAt": "2024-01-30T10:05:00Z"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "count": 1
    }
  }
}
```

### GET /wallets/:walletId/reconcile
Reconcile wallet balance with ledger.

**Response:**
```json
{
  "success": true,
  "data": {
    "walletId": "wallet-abc",
    "walletBalance": 10500,
    "ledgerBalance": 10500,
    "isBalanced": true,
    "difference": 0
  }
}
```

## Transaction Flow

### Debit Wallet (Critical Path)

```
BEGIN TRANSACTION
  ├─ 1. Check idempotency (ledger_entries.idempotency_key)
  │    └─ If exists → return cached result (idempotent)
  │
  ├─ 2. Lock wallet row (SELECT ... FOR UPDATE)
  │    └─ Blocks concurrent transactions on same wallet
  │
  ├─ 3. Validate wallet
  │    ├─ Wallet exists?
  │    ├─ Wallet active?
  │    └─ Sufficient balance?
  │
  ├─ 4. Calculate new balance
  │    └─ newBalance = currentBalance - amount
  │
  ├─ 5. Update wallet balance (optimistic locking)
  │    └─ WHERE id = ? AND version = ?
  │
  ├─ 6. Create ledger entry
  │    ├─ amount: -500 (negative for debit)
  │    ├─ balanceAfter: 9500
  │    └─ idempotencyKey: unique
  │
  └─ COMMIT (or ROLLBACK on error)
```

## Concurrency Control

### 1. Row-Level Locking
```sql
SELECT * FROM wallets WHERE id = ? FOR UPDATE;
```
- Blocks other transactions from reading/writing same wallet
- Prevents race conditions

### 2. Optimistic Locking
```sql
UPDATE wallets 
SET balance = ?, version = version + 1
WHERE id = ? AND version = ?;
```
- Detects concurrent modifications
- Returns 0 rows if version changed → retry

### 3. Idempotency
```sql
SELECT * FROM ledger_entries WHERE idempotency_key = ?;
```
- Duplicate requests return same result
- Network failures safe to retry

## Error Handling

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `WALLET_NOT_FOUND` | 404 | Wallet does not exist |
| `WALLET_ALREADY_EXISTS` | 409 | Wallet exists for user+currency |
| `INSUFFICIENT_BALANCE` | 422 | Not enough balance to debit |
| `WALLET_NOT_ACTIVE` | 403 | Wallet is frozen or closed |
| `CONCURRENT_MODIFICATION` | 409 | Version conflict, retry |
| `DUPLICATE_LEDGER_ENTRY` | 409 | Idempotency key already used |
| `INVALID_INPUT` | 400 | Missing or invalid parameters |

## Testing

### Run All Tests
```bash
npm test
```

### Run Unit Tests Only
```bash
npm run test:unit
```

### Watch Mode
```bash
npm run test:watch
```

### Coverage Report
```bash
npm test
# Coverage report in coverage/
```

## Development

### Install Dependencies
```bash
npm install
```

### Start Development Server
```bash
npm run dev
```

### Environment Variables
Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

## Database Setup

### Initialize Database
```bash
# From project root
./infrastructure/init-databases.sh
```

### Manual Setup
```bash
# Connect to PostgreSQL
psql -h localhost -p 5433 -U postgres

# Create database
CREATE DATABASE wallet_db;

# Run schema
\c wallet_db
\i infrastructure/schema-wallet-service.sql
```

## Folder Structure

```
wallet-service/
├── src/
│   ├── config/
│   │   └── index.js              # Configuration
│   ├── controllers/
│   │   └── WalletController.js   # HTTP handlers
│   ├── services/
│   │   └── WalletService.js      # Business logic
│   ├── infrastructure/
│   │   ├── database/
│   │   │   └── DatabaseClient.js # DB connection
│   │   └── repositories/
│   │       ├── WalletRepository.js
│   │       └── LedgerRepository.js
│   ├── routes/
│   │   └── walletRoutes.js       # Express routes
│   ├── middleware/
│   │   └── errorHandler.js       # Error handling
│   ├── utils/
│   │   └── logger.js             # Winston logger
│   └── index.js                  # Entry point
├── tests/
│   └── unit/
│       └── WalletService.test.js # Unit tests
├── .env                          # Environment config
├── .env.example                  # Env template
├── package.json
├── jest.config.js
└── Dockerfile
```

## Production Considerations

### 1. Connection Pooling
- Min: 2 connections
- Max: 10 connections
- Idle timeout: 30s

### 2. Transaction Isolation
- Level: `REPEATABLE READ`
- Prevents phantom reads
- Ensures consistency

### 3. Logging
- Structured JSON logs
- Request/response logging
- Error stack traces

### 4. Health Checks
- `/health` endpoint
- Database connectivity check
- Used by Docker/Kubernetes

### 5. Graceful Shutdown
- SIGTERM/SIGINT handlers
- Close HTTP server
- Close database connections

## License

MIT
