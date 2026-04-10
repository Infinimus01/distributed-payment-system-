# PayCore — Distributed Payment Infrastructure

> Production-grade payment processing engine built for fintech teams who are tired of rebuilding the same reliability patterns from scratch.

## The Problem

Every fintech team eventually builds the same things:
- A payment service that silently fails when the wallet service goes down
- A retry mechanism that charges customers twice on network errors  
- No way to detect when payments are marked "completed" but money never moved
- Fraud patterns that go unnoticed until chargebacks arrive

PayCore solves all four. Out of the box.

---

## What's Inside

### Circuit Breaker
Prevents cascading failures when downstream services degrade. After 5 consecutive failures, the circuit opens and fast-fails all requests — no more 10-second timeouts piling up. Recovers automatically after 30 seconds.

CLOSED (normal) → OPEN (fast-fail) → HALF_OPEN (testing) → CLOSED (recovered)
Tested: Full lifecycle under real wallet service outage. Recovery confirmed.

### Smart Retry with Error Classification
Not all errors should be retried. PayCore classifies errors before retrying:

| Error Type | Action |
|------------|--------|
| Network timeout, 503 | Retry with exponential backoff + jitter |
| Insufficient funds | Abort immediately — retrying wastes time |
| Card expired | Abort immediately |
| Unknown | Retry with caution |

Jitter prevents thundering herd on service recovery.

### Reconciliation Engine
Detects mismatches between your payment records and wallet ledger.

```bash
GET /api/payments/reconcile/run?from=2026-01-01&to=2026-01-02
```

Catches:
- `COMPLETED_LEDGER_MISSING` — payment marked completed, wallet never debited (money lost)
- `FAILED_BUT_DEBITED` — payment failed, wallet was debited (double charge risk) 
- `STUCK_PENDING` — payment stuck > 10 minutes (processing failure)
- `STUCK_PROCESSING` — payment stuck in processing > 5 minutes

### Anomaly Detection
Rule-based fraud signals on every payment:

| Rule | Threshold | Severity |
|------|-----------|----------|
| Velocity | >5 payments/60s same user | HIGH |
| Large Amount | >5000 per payment | MEDIUM |
| Failed Streak | >3 consecutive failures | HIGH |
| Duplicate Amount | Same amount 3x in 5min | MEDIUM |

```bash
GET /api/payments/anomaly/check/:userId
```

---

## Architecture

┌─────────────────┐
                │   API Gateway   │
                │  Auth + RateLimit│
                └────────┬────────┘
                         │
          ┌──────────────┴──────────────┐
          │                             │
┌─────────▼──────────┐      ┌──────────▼──────────┐
│  Payment Service   │      │   Wallet Service     │
│                    │      │                      │
│ • Circuit Breaker  │─────▶│ • Ledger (append-only│
│ • Smart Retry      │      │ • ACID transactions  │
│ • Anomaly Detection│      │ • Row-level locking  │
│ • Reconciliation   │      │                      │
└─────────┬──────────┘      └──────────┬───────────┘
          │                            │
┌─────────▼──────────────────────────▼─┐
│              PostgreSQL               │
│    Payment DB          Wallet DB      │
└───────────────────────────────────────┘
          │
┌─────────▼──────────┐
│        Redis        │
│ • Idempotency cache │
│ • Distributed locks │
│ • Anomaly tracking  │
│ • Rate limiting     │
└────────────────────┘

---

## Performance

Load tested with k6 — 50 concurrent users, 2 minutes:

| Metric | Result |
|--------|--------|
| Throughput | 51 req/sec |
| p50 latency | 9ms |
| p90 latency | 19ms |
| p95 latency | 32ms |
| Max latency | 177ms |

---

## Guarantees

**Exactly-once processing** — Idempotency keys stored in Redis (fast path) and PostgreSQL (truth path). Safe to retry indefinitely.

**Balance integrity** — Row-level locking + append-only ledger. Balance never goes negative under concurrent load.

**Fault tolerance** — Circuit breaker + smart retry. System degrades gracefully, not catastrophically.

---

## Quick Start

```bash
git clone https://github.com/Infinimus01/distributed-payment-system-
cd distributed-payment-system-
docker-compose up --build
```

```bash
# Create wallet
curl -X POST http://localhost:3000/api/wallets/create \
  -H "X-API-Key: test_key_merchant_001" \
  -H "Content-Type: application/json" \
  -d '{"userId":"550e8400-e29b-41d4-a716-446655440000","currency":"USD","initialBalance":10000}'

# Create and process payment
curl -X POST http://localhost:3000/api/payments \
  -H "X-API-Key: test_key_merchant_001" \
  -H "Idempotency-Key: unique-key-001" \
  -H "Content-Type: application/json" \
  -d '{"userId":"550e8400-e29b-41d4-a716-446655440000","amount":500,"currency":"USD","merchantId":"merchant_xyz"}'

# Run reconciliation
curl http://localhost:3000/api/payments/reconcile/run \
  -H "X-API-Key: test_key_merchant_001"
```

---

## Stack

Node.js · TypeScript · PostgreSQL · Redis · Docker · Kubernetes-ready

Built by [Amlendu Pandey](https://linkedin.com/in/amlendupandey16)
