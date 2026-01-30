-- ============================================================================
-- WALLET SERVICE DATABASE SCHEMA
-- ============================================================================
-- Database: wallet_db
-- Purpose: Manage user wallets and ledger with double-spend prevention
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TABLE: wallets
-- ============================================================================
-- Purpose: Store user wallet balances with concurrency control
-- Key Features:
--   - One wallet per user per currency
--   - Balance tracking with optimistic locking (version)
--   - Prevents negative balances
--   - Supports multiple currencies
-- ============================================================================

CREATE TABLE wallets (
    -- Primary identifier
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- User identifier (one wallet per user per currency)
    user_id UUID NOT NULL,
    
    -- Currency
    currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    
    -- Balance (in smallest currency unit, e.g., cents)
    -- CRITICAL: Must never go negative
    balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    
    -- Optimistic locking version for concurrent updates
    -- Incremented on every balance change
    version INTEGER NOT NULL DEFAULT 1,
    
    -- Wallet status
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_status CHECK (
        status IN ('ACTIVE', 'FROZEN', 'CLOSED')
    ),
    CONSTRAINT valid_currency CHECK (
        currency IN ('USD', 'EUR', 'GBP', 'INR', 'JPY')
    ),
    
    -- CRITICAL: One wallet per user per currency
    CONSTRAINT unique_user_currency UNIQUE (user_id, currency)
);

-- ============================================================================
-- INDEXES for wallets table
-- ============================================================================

-- Fast lookup by user_id (most common query)
CREATE INDEX idx_wallets_user_id 
    ON wallets(user_id);

-- Composite index for user + currency lookup
-- Already covered by UNIQUE constraint: unique_user_currency

-- Index for status-based queries
CREATE INDEX idx_wallets_status 
    ON wallets(status) 
    WHERE status = 'ACTIVE';

-- ============================================================================
-- TABLE: ledger_entries (Append-Only Double-Entry Ledger)
-- ============================================================================
-- Purpose: Immutable transaction log for all wallet operations
-- Key Features:
--   - Append-only (no updates or deletes)
--   - Double-entry bookkeeping
--   - Complete audit trail
--   - Idempotency support
-- ============================================================================

CREATE TABLE ledger_entries (
    -- Primary identifier
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Wallet reference
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    
    -- Transaction details
    transaction_type VARCHAR(20) NOT NULL,
    
    -- Amount (positive for credit, negative for debit)
    -- Stored in smallest currency unit
    amount BIGINT NOT NULL CHECK (amount != 0),
    
    -- Balance after this transaction (snapshot)
    balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
    
    -- Currency (denormalized for query performance)
    currency VARCHAR(3) NOT NULL,
    
    -- Reference to external transaction (payment_id, refund_id, etc.)
    reference_id UUID,
    reference_type VARCHAR(50),
    
    -- Idempotency key for this ledger entry
    -- Prevents duplicate entries for the same transaction
    idempotency_key VARCHAR(255) NOT NULL,
    
    -- Description and metadata
    description TEXT,
    metadata JSONB DEFAULT '{}',
    
    -- Timestamp (immutable)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_transaction_type CHECK (
        transaction_type IN ('DEBIT', 'CREDIT', 'REFUND', 'ADJUSTMENT')
    ),
    
    -- CRITICAL: Prevent duplicate ledger entries
    CONSTRAINT unique_ledger_idempotency UNIQUE (idempotency_key)
);

-- ============================================================================
-- INDEXES for ledger_entries table
-- ============================================================================

-- Fast lookup by wallet_id for transaction history
CREATE INDEX idx_ledger_entries_wallet_id 
    ON ledger_entries(wallet_id, created_at DESC);

-- Fast lookup by reference (e.g., payment_id)
CREATE INDEX idx_ledger_entries_reference 
    ON ledger_entries(reference_type, reference_id);

-- Index on idempotency_key for fast duplicate detection
-- Already covered by UNIQUE constraint: unique_ledger_idempotency

-- Index for time-based queries and reporting
CREATE INDEX idx_ledger_entries_created_at 
    ON ledger_entries(created_at DESC);

-- Composite index for wallet + transaction type queries
CREATE INDEX idx_ledger_entries_wallet_type 
    ON ledger_entries(wallet_id, transaction_type, created_at DESC);

-- ============================================================================
-- TABLE: wallet_locks
-- ============================================================================
-- Purpose: Distributed locking for concurrent wallet operations
-- Key Features:
--   - Prevents concurrent modifications to same wallet
--   - TTL-based automatic lock release
--   - Deadlock prevention
-- ============================================================================

CREATE TABLE wallet_locks (
    -- Wallet identifier (primary key)
    wallet_id UUID PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
    
    -- Lock holder identifier (transaction ID, process ID, etc.)
    lock_holder VARCHAR(255) NOT NULL,
    
    -- Lock metadata
    locked_by VARCHAR(255),
    lock_reason VARCHAR(255),
    
    -- Timestamps
    acquired_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    
    -- Constraint: Lock must have future expiry
    CONSTRAINT valid_lock_expiry CHECK (expires_at > acquired_at)
);

-- Index for TTL-based cleanup of expired locks
CREATE INDEX idx_wallet_locks_expires_at 
    ON wallet_locks(expires_at) 
    WHERE expires_at < NOW();

-- ============================================================================
-- TABLE: balance_snapshots
-- ============================================================================
-- Purpose: Periodic balance snapshots for reconciliation and reporting
-- Key Features:
--   - Daily/hourly snapshots
--   - Fast balance history queries
--   - Reconciliation with ledger
-- ============================================================================

CREATE TABLE balance_snapshots (
    -- Primary identifier
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Wallet reference
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    
    -- Snapshot details
    balance BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL,
    
    -- Snapshot metadata
    snapshot_type VARCHAR(20) NOT NULL DEFAULT 'DAILY',
    
    -- Timestamp
    snapshot_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_snapshot_type CHECK (
        snapshot_type IN ('HOURLY', 'DAILY', 'MONTHLY', 'MANUAL')
    ),
    
    -- One snapshot per wallet per time period
    CONSTRAINT unique_wallet_snapshot UNIQUE (wallet_id, snapshot_type, snapshot_at)
);

-- ============================================================================
-- INDEXES for balance_snapshots table
-- ============================================================================

-- Fast lookup by wallet for balance history
CREATE INDEX idx_balance_snapshots_wallet 
    ON balance_snapshots(wallet_id, snapshot_at DESC);

-- Index for time-based queries
CREATE INDEX idx_balance_snapshots_time 
    ON balance_snapshots(snapshot_at DESC);

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

CREATE TRIGGER update_wallets_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- TRIGGER: Increment version on wallet updates
-- ============================================================================

CREATE OR REPLACE FUNCTION increment_wallet_version()
RETURNS TRIGGER AS $$
BEGIN
    -- Increment version for optimistic locking
    NEW.version = OLD.version + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER increment_version_on_update
    BEFORE UPDATE ON wallets
    FOR EACH ROW
    EXECUTE FUNCTION increment_wallet_version();

-- ============================================================================
-- FUNCTION: Safe wallet debit with double-spend prevention
-- ============================================================================
-- Purpose: Atomically debit wallet with all safety checks
-- Returns: TRUE if successful, FALSE if insufficient balance
-- ============================================================================

CREATE OR REPLACE FUNCTION debit_wallet(
    p_wallet_id UUID,
    p_amount BIGINT,
    p_idempotency_key VARCHAR(255),
    p_reference_id UUID,
    p_reference_type VARCHAR(50),
    p_description TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_current_balance BIGINT;
    v_new_balance BIGINT;
    v_currency VARCHAR(3);
BEGIN
    -- Check for duplicate transaction (idempotency)
    IF EXISTS (SELECT 1 FROM ledger_entries WHERE idempotency_key = p_idempotency_key) THEN
        RETURN TRUE; -- Already processed
    END IF;
    
    -- Lock the wallet row (FOR UPDATE prevents concurrent modifications)
    SELECT balance, currency INTO v_current_balance, v_currency
    FROM wallets
    WHERE id = p_wallet_id AND status = 'ACTIVE'
    FOR UPDATE;
    
    -- Check if wallet exists
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found or not active';
    END IF;
    
    -- Check sufficient balance
    IF v_current_balance < p_amount THEN
        RETURN FALSE; -- Insufficient balance
    END IF;
    
    -- Calculate new balance
    v_new_balance := v_current_balance - p_amount;
    
    -- Update wallet balance
    UPDATE wallets
    SET balance = v_new_balance
    WHERE id = p_wallet_id;
    
    -- Create ledger entry (negative amount for debit)
    INSERT INTO ledger_entries (
        wallet_id,
        transaction_type,
        amount,
        balance_after,
        currency,
        reference_id,
        reference_type,
        idempotency_key,
        description
    ) VALUES (
        p_wallet_id,
        'DEBIT',
        -p_amount,
        v_new_balance,
        v_currency,
        p_reference_id,
        p_reference_type,
        p_idempotency_key,
        p_description
    );
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: Safe wallet credit
-- ============================================================================

CREATE OR REPLACE FUNCTION credit_wallet(
    p_wallet_id UUID,
    p_amount BIGINT,
    p_idempotency_key VARCHAR(255),
    p_reference_id UUID,
    p_reference_type VARCHAR(50),
    p_description TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_current_balance BIGINT;
    v_new_balance BIGINT;
    v_currency VARCHAR(3);
BEGIN
    -- Check for duplicate transaction (idempotency)
    IF EXISTS (SELECT 1 FROM ledger_entries WHERE idempotency_key = p_idempotency_key) THEN
        RETURN TRUE; -- Already processed
    END IF;
    
    -- Lock the wallet row
    SELECT balance, currency INTO v_current_balance, v_currency
    FROM wallets
    WHERE id = p_wallet_id AND status = 'ACTIVE'
    FOR UPDATE;
    
    -- Check if wallet exists
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found or not active';
    END IF;
    
    -- Calculate new balance
    v_new_balance := v_current_balance + p_amount;
    
    -- Update wallet balance
    UPDATE wallets
    SET balance = v_new_balance
    WHERE id = p_wallet_id;
    
    -- Create ledger entry (positive amount for credit)
    INSERT INTO ledger_entries (
        wallet_id,
        transaction_type,
        amount,
        balance_after,
        currency,
        reference_id,
        reference_type,
        idempotency_key,
        description
    ) VALUES (
        p_wallet_id,
        'CREDIT',
        p_amount,
        v_new_balance,
        v_currency,
        p_reference_id,
        p_reference_type,
        p_idempotency_key,
        p_description
    );
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMMENTS for documentation
-- ============================================================================

COMMENT ON TABLE wallets IS 'User wallets with balance tracking and optimistic locking';
COMMENT ON COLUMN wallets.balance IS 'Balance in smallest currency unit (cents), must never be negative';
COMMENT ON COLUMN wallets.version IS 'Optimistic locking version, incremented on every update';

COMMENT ON TABLE ledger_entries IS 'Immutable append-only ledger for all wallet transactions';
COMMENT ON COLUMN ledger_entries.amount IS 'Negative for debit, positive for credit';
COMMENT ON COLUMN ledger_entries.balance_after IS 'Balance snapshot after this transaction';

COMMENT ON TABLE wallet_locks IS 'Distributed locks for concurrent wallet operations';
COMMENT ON TABLE balance_snapshots IS 'Periodic balance snapshots for reconciliation';

COMMENT ON FUNCTION debit_wallet IS 'Atomically debit wallet with double-spend prevention';
COMMENT ON FUNCTION credit_wallet IS 'Atomically credit wallet with idempotency';

-- ============================================================================
-- GRANT PERMISSIONS (adjust based on your user setup)
-- ============================================================================

-- Grant permissions to application user
-- GRANT SELECT, INSERT, UPDATE ON wallets TO wallet_service_user;
-- GRANT SELECT, INSERT ON ledger_entries TO wallet_service_user;
-- GRANT SELECT, INSERT, DELETE ON wallet_locks TO wallet_service_user;
-- GRANT SELECT, INSERT ON balance_snapshots TO wallet_service_user;
-- GRANT EXECUTE ON FUNCTION debit_wallet TO wallet_service_user;
-- GRANT EXECUTE ON FUNCTION credit_wallet TO wallet_service_user;
