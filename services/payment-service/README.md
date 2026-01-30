# Payment Service

Production-grade payment processing service with **Redis-based idempotency** and **event publishing**.

## Features

- ✅ **Create Payment** - Idempotent payment creation
- ✅ **Redis Idempotency Cache** - Fast duplicate detection (24h TTL)
- ✅ **Database Idempotency** - Fallback if Redis cache expires
- ✅ **Event Publishing** - Redis pub/sub for PaymentCreated events
- ✅ **Race Condition Handling** - Handles concurrent duplicate requests
- ✅ **Status Updates** - Track payment lifecycle

## Architecture

### Idempotency Flow

```
Request with Idempotency-Key
         │
         ▼
  ┌──────────────┐
  │ Check Redis  │ ◄── Fast path (< 1ms)
  │    Cache     │
  └──────┬───────┘
         │
    ┌────┴────┐
    │ Found?  │
    └────┬────┘
         │
    Yes  │  No
    ┌────▼────┐
    │ Return  │
    │ Cached  │
    └─────────┘
         │
         ▼
  ┌──────────────┐
  │ Check        │ ◄── Fallback (cache expired)
  │ Database     │
  └──────┬───────┘
         │
    ┌────┴────┐
    │ Found?  │
    └────┬────┘
         │
    Yes  │  No
    ┌────▼────┐
    │ Return  │
    │ From DB │
    │ + Cache │
    └─────────┘
         │
         ▼
  ┌──────────────┐
  │   Create     │
  │   Payment    │
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ Store in     │
  │ Redis Cache  │
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │   Publish    │
  │    Event     │
  └──────────────┘
```

### Race Condition Handling

```
Request 1                Request 2
    │                        │
    ├─ Check Redis ──────────┤
    │  (miss)                │  (miss)
    │                        │
    ├─ Check DB ─────────────┤
    │  (miss)                │  (miss)
    │                        │
    ├─ INSERT ───────────────┤
    │  (success)             │  (DUPLICATE ERROR)
    │                        │
    │                        ├─ Fetch from DB
    │                        │  (found)
    │                        │
    │                        ├─ Cache in Redis
    │                        │
    ├─ Return 201 ───────────┼─ Return 200
    │  (created)             │  (duplicate)
```

## API Endpoints

### POST /payments
Create a new payment with idempotency.

**Headers:**
- `Idempotency-Key` (required): Unique key for this payment

**Request:**
```json
{
  "userId": "user-123",
  "amount": 5000,
  "currency": "USD",
  "merchantId": "merchant-abc",
  "description": "Order #12345",
  "metadata": {
    "orderId": "12345",
    "productId": "prod-789"
  }
}
```

**Response (201 Created - New Payment):**
```json
{
  "success": true,
  "data": {
    "payment": {
      "id": "payment-abc123",
      "userId": "user-123",
      "amount": 5000,
      "currency": "USD",
      "status": "PENDING",
      "merchantId": "merchant-abc",
      "description": "Order #12345",
      "createdAt": "2024-01-30T10:00:00Z"
    },
    "duplicate": false,
    "source": "created"
  }
}
```

**Response (200 OK - Duplicate from Cache):**
```json
{
  "success": true,
  "data": {
    "payment": {
      "id": "payment-abc123",
      "userId": "user-123",
      "amount": 5000,
      "currency": "USD",
      "status": "PENDING",
      "merchantId": "merchant-abc",
      "description": "Order #12345",
      "createdAt": "2024-01-30T10:00:00Z"
    },
    "duplicate": true,
    "source": "cache"
  }
}
```

**Response (200 OK - Duplicate from Database):**
```json
{
  "success": true,
  "data": {
    "payment": { ... },
    "duplicate": true,
    "source": "database"
  }
}
```

**Error Response (Missing Idempotency Key):**
```json
{
  "success": false,
  "error": "INVALID_INPUT",
  "message": "Idempotency-Key header is required"
}
```

### GET /payments/:paymentId
Get payment details.

**Response:**
```json
{
  "success": true,
  "data": {
    "payment": {
      "id": "payment-abc123",
      "userId": "user-123",
      "amount": 5000,
      "currency": "USD",
      "status": "PENDING",
      "merchantId": "merchant-abc",
      "description": "Order #12345",
      "metadata": { ... },
      "gatewayTransactionId": null,
      "failureReason": null,
      "createdAt": "2024-01-30T10:00:00Z",
      "updatedAt": "2024-01-30T10:00:00Z",
      "processedAt": null
    }
  }
}
```

### GET /payments/user/:userId
Get payments by user ID.

**Query Parameters:**
- `limit` (default: 10)
- `offset` (default: 0)

**Response:**
```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "id": "payment-abc123",
        "amount": 5000,
        "currency": "USD",
        "status": "PENDING",
        "merchantId": "merchant-abc",
        "description": "Order #12345",
        "createdAt": "2024-01-30T10:00:00Z"
      }
    ],
    "pagination": {
      "limit": 10,
      "offset": 0,
      "count": 1
    }
  }
}
```

### PATCH /payments/:paymentId/status
Update payment status.

**Request:**
```json
{
  "status": "COMPLETED",
  "gatewayTransactionId": "gw_txn_12345",
  "failureReason": null
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "payment": {
      "id": "payment-abc123",
      "status": "COMPLETED",
      "gatewayTransactionId": "gw_txn_12345",
      "failureReason": null,
      "processedAt": "2024-01-30T10:05:00Z",
      "updatedAt": "2024-01-30T10:05:00Z"
    }
  }
}
```

## Event Publishing

### PaymentCreated Event

Published to Redis channel: `payment-events`

```json
{
  "eventType": "PaymentCreated",
  "eventId": "event_1706608800000_abc123",
  "timestamp": "2024-01-30T10:00:00Z",
  "payload": {
    "paymentId": "payment-abc123",
    "userId": "user-123",
    "amount": 5000,
    "currency": "USD",
    "status": "PENDING",
    "merchantId": "merchant-abc",
    "idempotencyKey": "payment_user123_order12345",
    "createdAt": "2024-01-30T10:00:00Z"
  }
}
```

### PaymentStatusChanged Event

```json
{
  "eventType": "PaymentStatusChanged",
  "eventId": "event_1706609100000_def456",
  "timestamp": "2024-01-30T10:05:00Z",
  "payload": {
    "paymentId": "payment-abc123",
    "userId": "user-123",
    "previousStatus": "PENDING",
    "newStatus": "COMPLETED",
    "amount": 5000,
    "currency": "USD",
    "updatedAt": "2024-01-30T10:05:00Z"
  }
}
```

## Idempotency Guarantees

### 1. Same Idempotency Key → Same Result

```bash
# First request
curl -X POST http://localhost:3001/payments \
  -H "Idempotency-Key: payment_123" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-123","amount":1000,"currency":"USD","merchantId":"merchant-001"}'

# Response: 201 Created, payment-abc created

# Second request (duplicate)
curl -X POST http://localhost:3001/payments \
  -H "Idempotency-Key: payment_123" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-123","amount":1000,"currency":"USD","merchantId":"merchant-001"}'

# Response: 200 OK, same payment-abc returned (duplicate: true)
```

### 2. Network Failure Safe

```
Client                  Payment Service
  │                            │
  ├─ POST /payments ──────────►│
  │  Idempotency-Key: xyz      │
  │                            ├─ Create payment
  │                            ├─ Store in Redis
  │                            ├─ Publish event
  │                            │
  │◄─────────────────────────X │ (network failure)
  │                            │
  ├─ POST /payments ──────────►│ (retry)
  │  Idempotency-Key: xyz      │
  │                            ├─ Check Redis (HIT)
  │◄─ 200 OK (duplicate) ──────┤
  │  Same payment returned     │
```

### 3. Concurrent Requests

```
Request A                Request B
    │                        │
    ├─ Idempotency-Key: xyz ─┤
    │                        │
    ├─ Check Redis (miss) ───┤
    │                        │
    ├─ Check DB (miss) ──────┤
    │                        │
    ├─ INSERT ───────────────┤
    │  (success)             │  (DUPLICATE ERROR)
    │                        │
    │                        ├─ Fetch from DB
    │                        │  (found)
    │                        │
    ├─ 201 Created ──────────┼─ 200 OK (duplicate)
```

## Testing

### Run All Tests
```bash
npm test
```

### Run Unit Tests
```bash
npm run test:unit
```

### Watch Mode
```bash
npm run test:watch
```

### Test Coverage
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
```bash
cp .env.example .env
```

## Database Setup

### Initialize Database
```bash
# From project root
./infrastructure/init-databases.sh
```

## Folder Structure

```
payment-service/
├── src/
│   ├── config/
│   │   └── index.js                  # Configuration
│   ├── controllers/
│   │   └── PaymentController.js      # HTTP handlers
│   ├── services/
│   │   ├── PaymentService.js         # Business logic
│   │   ├── IdempotencyService.js     # Redis idempotency
│   │   └── EventPublisher.js         # Event publishing
│   ├── infrastructure/
│   │   ├── database/
│   │   │   └── DatabaseClient.js     # PostgreSQL client
│   │   ├── cache/
│   │   │   └── RedisClient.js        # Redis client
│   │   └── repositories/
│   │       └── PaymentRepository.js  # Data access
│   ├── routes/
│   │   └── paymentRoutes.js          # Express routes
│   ├── middleware/
│   │   └── errorHandler.js           # Error handling
│   ├── utils/
│   │   └── logger.js                 # Winston logger
│   └── index.js                      # Entry point
├── tests/
│   └── unit/
│       └── PaymentService.test.js    # Unit tests
├── .env
├── .env.example
├── package.json
├── jest.config.js
└── Dockerfile
```

## Production Considerations

### 1. Redis Cache TTL
- Default: 24 hours (86400 seconds)
- Configurable via `IDEMPOTENCY_KEY_TTL`
- After expiry, falls back to database check

### 2. Event Publishing Failure
- Event publishing failures don't fail the payment
- Logged as errors for monitoring
- Consider dead letter queue for critical events

### 3. Redis Unavailability
- Cache checks return null (graceful degradation)
- Falls back to database idempotency check
- Payment creation still succeeds

### 4. Database Constraints
- Unique index on `idempotency_key`
- Handles race conditions at DB level
- Returns `DUPLICATE_PAYMENT` error

### 5. Idempotency Key Format
- Recommended: `{operation}_{userId}_{referenceId}`
- Example: `payment_user123_order456`
- Must be unique per payment intent

## Error Handling

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `PAYMENT_NOT_FOUND` | 404 | Payment does not exist |
| `DUPLICATE_PAYMENT` | 409 | Payment already exists |
| `INVALID_INPUT` | 400 | Missing or invalid parameters |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected error |

## Monitoring

### Health Check
```bash
curl http://localhost:3001/health
```

**Response:**
```json
{
  "status": "healthy",
  "service": "payment-service",
  "timestamp": "2024-01-30T10:00:00Z",
  "database": {
    "healthy": true,
    "timestamp": "2024-01-30T10:00:00Z"
  },
  "redis": {
    "healthy": true,
    "connected": true
  }
}
```

## License

MIT
