-- ============================================================================
-- PAYMENT SERVICE DATABASE SCHEMA
-- ============================================================================
-- Database: payment_db
-- Purpose: Handle payment processing with idempotency guarantees
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TABLE: payments
-- ============================================================================
-- Purpose: Store all payment transactions with idempotency enforcement
-- Key Features:
--   - Idempotency key prevents duplicate payments
--   - Status tracking for payment lifecycle
--   - Audit trail with timestamps
--   - Foreign key to external gateway transactions
-- ============================================================================

CREATE TABLE payments (
    -- Primary identifier
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- User and merchant information
    user_id UUID NOT NULL,
    merchant_id VARCHAR(255) NOT NULL,
    
    -- Payment amount (stored in smallest currency unit, e.g., cents)
    -- Using BIGINT to avoid floating point precision issues
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    
    -- Payment status with explicit states
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    
    -- Idempotency key - CRITICAL for preventing duplicate payments
    -- Must be unique and indexed for fast lookups
    idempotency_key VARCHAR(255) NOT NULL,
    
    -- Payment metadata
    description TEXT,
    metadata JSONB DEFAULT '{}',
    
    -- External gateway reference
    gateway_transaction_id VARCHAR(255),
    
    -- Failure tracking
    failure_reason TEXT,
    retry_count INTEGER DEFAULT 0,
    
    -- Timestamps for audit trail
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    
    -- Constraints
    CONSTRAINT valid_status CHECK (
        status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED')
    ),
    CONSTRAINT valid_currency CHECK (
        currency IN ('USD', 'EUR', 'GBP', 'INR', 'JPY')
    )
);

-- ============================================================================
-- INDEXES for payments table
-- ============================================================================

-- CRITICAL: Unique index on idempotency_key to prevent duplicate payments
-- This is the primary mechanism for idempotency enforcement
CREATE UNIQUE INDEX idx_payments_idempotency_key 
    ON payments(idempotency_key);

-- Fast lookup by payment ID (already covered by PRIMARY KEY)

-- Fast lookup by user for payment history
CREATE INDEX idx_payments_user_id 
    ON payments(user_id, created_at DESC);

-- Fast lookup by status for processing queues
CREATE INDEX idx_payments_status 
    ON payments(status, created_at ASC) 
    WHERE status IN ('PENDING', 'PROCESSING');

-- Fast lookup by gateway transaction ID for reconciliation
CREATE INDEX idx_payments_gateway_transaction_id 
    ON payments(gateway_transaction_id) 
    WHERE gateway_transaction_id IS NOT NULL;

-- Composite index for merchant reporting
CREATE INDEX idx_payments_merchant_status 
    ON payments(merchant_id, status, created_at DESC);

-- Index on created_at for time-based queries and cleanup
CREATE INDEX idx_payments_created_at 
    ON payments(created_at DESC);

-- ============================================================================
-- TABLE: payment_events (Event Sourcing / Audit Log)
-- ============================================================================
-- Purpose: Immutable audit trail of all payment state changes
-- Key Features:
--   - Append-only (no updates or deletes)
--   - Complete history of payment lifecycle
--   - Debugging and compliance
-- ============================================================================

CREATE TABLE payment_events (
    -- Primary identifier
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Reference to payment
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    
    -- Event details
    event_type VARCHAR(50) NOT NULL,
    
    -- Previous and new status for state transitions
    previous_status VARCHAR(20),
    new_status VARCHAR(20),
    
    -- Actor who triggered the event (user_id, system, admin_id)
    actor_id VARCHAR(255),
    actor_type VARCHAR(50) DEFAULT 'system',
    
    -- Event metadata (errors, gateway responses, etc.)
    metadata JSONB DEFAULT '{}',
    
    -- Timestamp (immutable)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES for payment_events table
-- ============================================================================

-- Fast lookup of events for a specific payment
CREATE INDEX idx_payment_events_payment_id 
    ON payment_events(payment_id, created_at ASC);

-- Fast lookup by event type for analytics
CREATE INDEX idx_payment_events_event_type 
    ON payment_events(event_type, created_at DESC);

-- ============================================================================
-- TABLE: idempotency_cache
-- ============================================================================
-- Purpose: Fast idempotency check with TTL (complementary to payments table)
-- Key Features:
--   - Quick lookup before hitting payments table
--   - TTL-based cleanup (24 hours)
--   - Response caching for identical requests
-- ============================================================================

CREATE TABLE idempotency_cache (
    -- Idempotency key (primary key)
    idempotency_key VARCHAR(255) PRIMARY KEY,
    
    -- Reference to payment
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    
    -- Cached response for quick return
    response_payload JSONB,
    response_status_code INTEGER,
    
    -- TTL management
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Index for TTL-based cleanup
CREATE INDEX idx_idempotency_cache_expires_at 
    ON idempotency_cache(expires_at) 
    WHERE expires_at < NOW();

-- ============================================================================
-- TRIGGER: Update updated_at timestamp automatically
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- TRIGGER: Automatically log payment state changes
-- ============================================================================

CREATE OR REPLACE FUNCTION log_payment_state_change()
RETURNS TRIGGER AS $$
BEGIN
    -- Only log if status changed
    IF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status) THEN
        INSERT INTO payment_events (
            payment_id,
            event_type,
            previous_status,
            new_status,
            metadata
        ) VALUES (
            NEW.id,
            'STATUS_CHANGED',
            OLD.status,
            NEW.status,
            jsonb_build_object(
                'previous_status', OLD.status,
                'new_status', NEW.status,
                'updated_at', NEW.updated_at
            )
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER log_payment_status_change
    AFTER UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION log_payment_state_change();

-- ============================================================================
-- COMMENTS for documentation
-- ============================================================================

COMMENT ON TABLE payments IS 'Core payment transactions with idempotency enforcement';
COMMENT ON COLUMN payments.idempotency_key IS 'CRITICAL: Unique key to prevent duplicate payments';
COMMENT ON COLUMN payments.amount IS 'Amount in smallest currency unit (cents) to avoid floating point issues';
COMMENT ON COLUMN payments.status IS 'Payment lifecycle status: PENDING -> PROCESSING -> COMPLETED/FAILED';

COMMENT ON TABLE payment_events IS 'Immutable audit log of all payment state changes';
COMMENT ON TABLE idempotency_cache IS 'Fast idempotency check with TTL-based cleanup';

-- ============================================================================
-- GRANT PERMISSIONS (adjust based on your user setup)
-- ============================================================================

-- Grant permissions to application user
-- GRANT SELECT, INSERT, UPDATE ON payments TO payment_service_user;
-- GRANT SELECT, INSERT ON payment_events TO payment_service_user;
-- GRANT SELECT, INSERT, DELETE ON idempotency_cache TO payment_service_user;
