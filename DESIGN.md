# System Design Document

**Project**: Distributed Payment Processing System  
**Version**: 1.0  
**Status**: Implementation Complete

---

## 1. Requirements

### Functional Requirements
*   **Process Payments**: Support `create`, `process` (debit), and `refund` operations.
*   **Wallet Management**: Maintain user balances with support for atomic credits and debits.
*   **Idempotency**: Ensure no transaction is processed twice, even with network failures or client retries.
*   **Concurrency**: Handle simultaneous requests for the same wallet safely.
*   **Auditability**: Keep a complete history of all financial movements (Ledger).

### Non-Functional Requirements
*   **Consistency**: Strong consistency for wallet balances (ACID).
*   **Availability**: High availability for API intake; graceful degradation if dependencies fail.
*   **Scalability**: Horizontally scalable services (stateless application tier).
*   **Security**: API Key authentication, input validation, and secure headers.
*   **performance**: Low latency for high-volume reads/writes using Redis caching.

---

## 2. Architecture Decisions

### Microservices Pattern
We chose a microservices architecture to decouple domains:
*   **API Gateway**: Offloads cross-cutting concerns (Auth, Rate Limiting) to protect downstream services.
*   **Payment Service**: Focuses on the lifecycle of a "Payment Intent" and orchestration.
*   **Wallet Service**: Strictly focuses on "Ledger Management" and balance math.

**Trade-off**: Increases operational complexity (networking, deployments) but allows independent scaling and clearer failure isolation.

### Database per Service
*   `payment_db`: Owned by Payment Service.
*   `wallet_db`: Owned by Wallet Service.

**Rationale**: Preventing one service from coupling directly to another's schema ensures services can evolve independently. Data sharing is done via APIs/Events, not shared tables.

### Redis for Idempotency & Locking
*   **Idempotency**: We check Redis first for a seen `Idempotency-Key`. This offloads read pressure from Postgres for duplicate requests.
*   **Locking**: We use Redis distributed locks (or DB row locks) ensuring that multiple debit requests for the same wallet are serialized, preventing race conditions.

---

## 3. Data Model

### Payment Service Schema
*   **Payments Table**:
    *   `id` (UUID, PK)
    *   `idempotency_key` (Unique Index) - crucial for deduplication.
    *   `status` (Enum: PENDING, PROCESSING, COMPLETED, FAILED, REFUNDED)
    *   `amount`, `currency`, `user_id`
*   **Payment Events**: Immutable log of state transitions (e.g., `PENDING` -> `PROCESSING`).

### Wallet Service Schema
*   **Wallets Table**:
    *   `id` (PK)
    *   `balance` (BigInt) - Stored in smallest unit (cents) to avoid floating point errors.
    *   `user_id`
    *   `version` (Int) - For Optimistic Concurrency Control.
*   **Ledger Entries Table**:
    *   `id` (PK)
    *   `wallet_id` (FK)
    *   `amount` (Signed BigInt) - Positive for credit, negative for debit.
    *   `type` (CREDIT/DEBIT)
    *   `reference_id` (Idempotency mapping to Payment ID).

---

## 4. Failure Handling & Reliability

### Idempotency Strategy
1.  **Client sends `Idempotency-Key`**.
2.  **Layer 1 (Cache)**: Check Redis. If key exists, return cached response immediately.
3.  **Layer 2 (Storage)**: If Redis misses, check Postgres `idempotency_key` unique constraint.
4.  **Layer 3 (Logic)**: If executing, lock the operation. On success, write to DB and cache result in Redis.

### Retry Logic (Exponential Backoff)
When calling the Wallet Service, the Payment Service uses smart retries:
*   **Transient Errors** (Network, Timeout, 503): Retry with backoff (1s, 2s, 4s...).
*   **Permanent Errors** (400 Bad Request, Insufficient Funds): Do not retry. Fail immediately.

### Graceful Degradation
*   If **Redis** is down: The system falls back to hitting the Database directly for idempotency checks. Performance degrades, but availability is maintained.
*   If **Wallet Service** is down: Payment creation (`PENDING`) still succeeds. Processing (`DEBIT`) fails safely, allowing the client to retry processing later.

---

## 5. Trade-offs

*   **Synchronous Processing vs. Async Queues**: 
    *   *Decision*: We currently process payments via HTTP calls (Synchronous) for simplicity and immediate feedback.
    *   *Trade-off*: Higher latency for the client. If the chain is long, latency stacks up.
    *   *Mitigation*: We moved to a 2-step process (Create -> Process) so 'Create' is fast. 'Process' can be offloaded.

*   **Pessimistic vs. Optimistic Locking**:
    *   *Decision*: Reference implementation supports both, but typically Row-Level Locking (`FOR UPDATE`) is used for Wallet balances to ensure strict consistency.
    *   *Trade-off*: Reduces throughput on a *single* wallet (hot wallet problem).
    *   *Mitigation*: Redis distributed locks can reduce DB lock contention.

---

## 6. Future Improvements

1.  **Async Queue (Kafka/RabbitMQ)**: Move the 'Process' step to a background worker. The API would return 202 Accepted, and the client polls for status or listens to webhooks.
2.  **Reconciliation Service**: A background cron job that scans for 'stuck' payments (e.g., in `PROCESSING` state for > 5 mins) and double-checks their status with the Wallet Service to auto-repair.
3.  **Circuit Breakers**: Implement automatic circuit breaking for downstream services (Wallet) to prevent cascading failures during outages.
4.  **Dashboard**: A UI for merchants to view transaction history and trigger refunds.

---

*This document serves as the primary artifact for understanding the system's design philosophy and operational guarantees.*
