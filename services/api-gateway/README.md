# API Gateway

Production-grade API Gateway with **API key authentication**, **Redis-based rate limiting**, and **request forwarding** to downstream services.

## Features

- ✅ **API Key Authentication** - Validates X-API-Key header
- ✅ **Rate Limiting** - Per-API-key limits using Redis
- ✅ **Request Forwarding** - Proxies to Payment/Wallet services
- ✅ **Centralized Error Handling** - Consistent error responses
- ✅ **Health Checks** - Gateway + downstream services
- ✅ **No Database** - Stateless, uses Redis only

## Architecture

```
Client
  │
  ▼
┌─────────────────┐
│  API Gateway    │
│  (Port 3000)    │
├─────────────────┤
│ 1. Auth         │ ◄── X-API-Key validation
│ 2. Rate Limit   │ ◄── Redis counter
│ 3. Forward      │ ◄── Proxy to services
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
Payment    Wallet
Service    Service
(3001)     (3002)
```

## Rate Limiting Algorithm

### Sliding Window Counter

```
Window: 1 minute (60,000ms)
Key: ratelimit:{apiKey}:{windowStart}

Example:
  Time: 2024-01-30T10:05:23
  Window: 2024-01-30T10:05:00 (rounded down)
  Key: ratelimit:test_key_merchant_001:1706608500000
  
Request Flow:
  1. INCR ratelimit:test_key_merchant_001:1706608500000 → 1
  2. EXPIRE ratelimit:test_key_merchant_001:1706608500000 70 (60s + 10s buffer)
  3. Check: 1 <= 100 (maxRequests) → Allow
  4. Add headers:
     X-RateLimit-Limit: 100
     X-RateLimit-Remaining: 99
     X-RateLimit-Reset: 1706608560 (Unix timestamp)
```

## API Endpoints

All endpoints require `X-API-Key` header and are rate-limited.

### POST /api/payments
Create a new payment.

**Headers:**
- `X-API-Key` (required): Your API key
- `Idempotency-Key` (required): Unique key for this payment

**Request:**
```bash
curl -X POST http://localhost:3000/api/payments \
  -H "X-API-Key: test_key_merchant_001" \
  -H "Idempotency-Key: payment_user123_order456" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-123",
    "amount": 5000,
    "currency": "USD",
    "merchantId": "merchant-001",
    "description": "Order #456"
  }'
```

**Response (201 Created):**
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
      "merchantId": "merchant-001",
      "description": "Order #456",
      "createdAt": "2024-01-30T10:00:00Z"
    },
    "duplicate": false,
    "source": "created"
  }
}
```

**Response Headers:**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1706608560
```

### POST /api/payments/:paymentId/process
Process a payment (debit wallet).

**Request:**
```bash
curl -X POST http://localhost:3000/api/payments/payment-abc123/process \
  -H "X-API-Key: test_key_merchant_001" \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": "wallet-xyz789"
  }'
```

**Response (200 OK):**
```json
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
```

### GET /api/payments/:paymentId
Get payment details.

**Request:**
```bash
curl http://localhost:3000/api/payments/payment-abc123 \
  -H "X-API-Key: test_key_merchant_001"
```

### GET /api/payments/user/:userId
Get payments by user ID.

**Request:**
```bash
curl "http://localhost:3000/api/payments/user/user-123?limit=10&offset=0" \
  -H "X-API-Key: test_key_merchant_001"
```

### POST /api/payments/:paymentId/refund
Refund a payment.

**Request:**
```bash
curl -X POST http://localhost:3000/api/payments/payment-abc123/refund \
  -H "X-API-Key: test_key_merchant_001" \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": "wallet-xyz789"
  }'
```

## Authentication

### API Key Validation

**Header:**
```
X-API-Key: test_key_merchant_001
```

**Validation:**
1. Check if header exists
2. Lookup key in `validKeys` config
3. Attach key info to request
4. Continue to rate limiter

**Error Response (Missing Key):**
```json
{
  "success": false,
  "error": "UNAUTHORIZED",
  "message": "API key is required. Please provide X-API-Key header."
}
```

**Error Response (Invalid Key):**
```json
{
  "success": false,
  "error": "UNAUTHORIZED",
  "message": "Invalid API key"
}
```

## Rate Limiting

### Per-API-Key Limits

| API Key | Tier | Max Requests | Window |
|---------|------|--------------|--------|
| `test_key_merchant_001` | Standard | 100 | 1 minute |
| `test_key_merchant_002` | Premium | 1000 | 1 minute |

### Rate Limit Exceeded

**Response (429 Too Many Requests):**
```json
{
  "success": false,
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Rate limit exceeded. Maximum 100 requests per 60 seconds.",
  "retryAfter": 37
}
```

**Headers:**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1706608560
```

### Graceful Degradation

If Redis fails:
- Request is **allowed** (fail open)
- Warning header added: `X-RateLimit-Status: degraded`
- Error logged for monitoring

## Error Handling

### Service Unavailable (503)

```json
{
  "success": false,
  "error": "SERVICE_UNAVAILABLE",
  "message": "Downstream service is currently unavailable. Please try again later."
}
```

### Gateway Timeout (504)

```json
{
  "success": false,
  "error": "GATEWAY_TIMEOUT",
  "message": "Request to downstream service timed out. Please try again."
}
```

### Bad Gateway (502)

```json
{
  "success": false,
  "error": "BAD_GATEWAY",
  "message": "Error communicating with downstream service"
}
```

## Health Check

### GET /health

**No authentication required.**

**Response (200 OK - Healthy):**
```json
{
  "status": "healthy",
  "service": "api-gateway",
  "timestamp": "2024-01-30T10:00:00Z",
  "redis": {
    "healthy": true,
    "connected": true
  },
  "services": {
    "paymentService": {
      "healthy": true,
      "status": 200,
      "data": {
        "status": "healthy",
        "service": "payment-service"
      }
    },
    "walletService": {
      "healthy": true,
      "status": 200,
      "data": {
        "status": "healthy",
        "service": "wallet-service"
      }
    }
  }
}
```

**Response (503 Service Unavailable - Unhealthy):**
```json
{
  "status": "unhealthy",
  "service": "api-gateway",
  "timestamp": "2024-01-30T10:00:00Z",
  "redis": {
    "healthy": false,
    "connected": false,
    "error": "Connection refused"
  },
  "services": {
    "paymentService": {
      "healthy": false,
      "error": "connect ECONNREFUSED"
    }
  }
}
```

## Development

### Install Dependencies
```bash
cd services/api-gateway
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

## Testing

### Manual Testing

```bash
# 1. Start services
docker-compose up -d redis
cd services/payment-service && npm start &
cd services/wallet-service && npm start &
cd services/api-gateway && npm start

# 2. Test authentication
curl http://localhost:3000/api/payments/test-123
# Response: 401 Unauthorized (missing API key)

curl http://localhost:3000/api/payments/test-123 \
  -H "X-API-Key: invalid_key"
# Response: 401 Unauthorized (invalid key)

curl http://localhost:3000/api/payments/test-123 \
  -H "X-API-Key: test_key_merchant_001"
# Response: Forwarded to payment service

# 3. Test rate limiting
for i in {1..105}; do
  curl -s http://localhost:3000/api/payments/test-123 \
    -H "X-API-Key: test_key_merchant_001" \
    -o /dev/null -w "%{http_code}\n"
done
# First 100: 200/404
# Next 5: 429 (rate limit exceeded)
```

## Folder Structure

```
api-gateway/
├── src/
│   ├── config/
│   │   └── index.js                  # Configuration
│   ├── infrastructure/
│   │   └── cache/
│   │       └── RedisClient.js        # Redis client
│   ├── middleware/
│   │   ├── apiKeyAuth.js             # API key validation
│   │   ├── rateLimiter.js            # Rate limiting
│   │   └── errorHandler.js           # Error handling
│   ├── services/
│   │   └── ServiceProxy.js           # Request forwarding
│   ├── routes/
│   │   └── paymentRoutes.js          # Payment routes
│   ├── utils/
│   │   └── logger.js                 # Winston logger
│   └── index.js                      # Entry point
├── .env
├── .env.example
├── package.json
└── Dockerfile
```

## Production Considerations

### 1. API Key Management
- **Current**: Hardcoded in config
- **Production**: Store in database or secrets manager (AWS Secrets Manager, HashiCorp Vault)
- **Rotation**: Implement key rotation mechanism

### 2. Rate Limiting
- **Window**: Configurable per tier
- **Distributed**: Redis ensures consistency across multiple gateway instances
- **Monitoring**: Track rate limit hits per API key

### 3. Service Discovery
- **Current**: Hardcoded URLs
- **Production**: Use service discovery (Consul, Kubernetes DNS)

### 4. Circuit Breaker
- **Future**: Add circuit breaker for downstream services
- **Library**: `opossum` or custom implementation

### 5. Caching
- **Future**: Cache GET responses in Redis
- **TTL**: Configurable per endpoint

## Monitoring

### Key Metrics

1. **Request Rate**: Requests per second
2. **Rate Limit Hits**: % of requests rate-limited
3. **Auth Failures**: Invalid API keys
4. **Service Errors**: 5xx responses from downstream
5. **Latency**: P50, P95, P99 response times

### Logs

```json
{
  "level": "info",
  "message": "Incoming request",
  "method": "POST",
  "path": "/api/payments",
  "ip": "127.0.0.1"
}

{
  "level": "warn",
  "message": "Rate limit exceeded",
  "apiKey": "test_key_m...",
  "name": "Test Merchant 001",
  "requestCount": 101,
  "maxRequests": 100
}

{
  "level": "error",
  "message": "Service unavailable",
  "service": "paymentService",
  "error": "connect ECONNREFUSED"
}
```

## License

MIT
