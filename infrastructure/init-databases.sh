#!/bin/bash

# ============================================================================
# Database Initialization Script
# ============================================================================
# Purpose: Initialize both payment_db and wallet_db with schemas
# Usage: ./init-databases.sh
# ============================================================================

set -e  # Exit on error

echo "🚀 Initializing Payment Processing System Databases..."

# Configuration
POSTGRES_PAYMENT_HOST=${DB_HOST_PAYMENT:-localhost}
POSTGRES_PAYMENT_PORT=${DB_PORT_PAYMENT:-5432}
POSTGRES_WALLET_HOST=${DB_HOST_WALLET:-localhost}
POSTGRES_WALLET_PORT=${DB_PORT_WALLET:-5433}
POSTGRES_USER=${DB_USER:-postgres}
POSTGRES_PASSWORD=${DB_PASSWORD:-postgres}

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# ============================================================================
# Wait for PostgreSQL to be ready
# ============================================================================

wait_for_postgres() {
    local host=$1
    local port=$2
    local max_attempts=30
    local attempt=1

    echo -e "${YELLOW}⏳ Waiting for PostgreSQL at $host:$port...${NC}"
    
    while [ $attempt -le $max_attempts ]; do
        if PGPASSWORD=$POSTGRES_PASSWORD psql -h $host -p $port -U $POSTGRES_USER -c '\q' 2>/dev/null; then
            echo -e "${GREEN}✅ PostgreSQL is ready at $host:$port${NC}"
            return 0
        fi
        
        echo "   Attempt $attempt/$max_attempts..."
        sleep 2
        ((attempt++))
    done
    
    echo -e "${RED}❌ PostgreSQL not ready after $max_attempts attempts${NC}"
    return 1
}

# ============================================================================
# Initialize Payment Database
# ============================================================================

init_payment_db() {
    echo ""
    echo -e "${YELLOW}📦 Initializing Payment Database (payment_db)...${NC}"
    
    # Create database if not exists
    PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_PAYMENT_HOST -p $POSTGRES_PAYMENT_PORT -U $POSTGRES_USER -tc \
        "SELECT 1 FROM pg_database WHERE datname = 'payment_db'" | grep -q 1 || \
        PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_PAYMENT_HOST -p $POSTGRES_PAYMENT_PORT -U $POSTGRES_USER -c \
        "CREATE DATABASE payment_db"
    
    echo "   Database 'payment_db' ready"
    
    # Run schema
    echo "   Running schema migrations..."
    PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_PAYMENT_HOST -p $POSTGRES_PAYMENT_PORT -U $POSTGRES_USER -d payment_db \
        -f infrastructure/schema-payment-service.sql
    
    echo -e "${GREEN}✅ Payment Database initialized${NC}"
}

# ============================================================================
# Initialize Wallet Database
# ============================================================================

init_wallet_db() {
    echo ""
    echo -e "${YELLOW}📦 Initializing Wallet Database (wallet_db)...${NC}"
    
    # Create database if not exists
    PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_WALLET_HOST -p $POSTGRES_WALLET_PORT -U $POSTGRES_USER -tc \
        "SELECT 1 FROM pg_database WHERE datname = 'wallet_db'" | grep -q 1 || \
        PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_WALLET_HOST -p $POSTGRES_WALLET_PORT -U $POSTGRES_USER -c \
        "CREATE DATABASE wallet_db"
    
    echo "   Database 'wallet_db' ready"
    
    # Run schema
    echo "   Running schema migrations..."
    PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_WALLET_HOST -p $POSTGRES_WALLET_PORT -U $POSTGRES_USER -d wallet_db \
        -f infrastructure/schema-wallet-service.sql
    
    echo -e "${GREEN}✅ Wallet Database initialized${NC}"
}

# ============================================================================
# Verify Installation
# ============================================================================

verify_installation() {
    echo ""
    echo -e "${YELLOW}🔍 Verifying installation...${NC}"
    
    # Check payment_db tables
    local payment_tables=$(PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_PAYMENT_HOST -p $POSTGRES_PAYMENT_PORT \
        -U $POSTGRES_USER -d payment_db -t -c \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")
    
    echo "   Payment DB tables: $payment_tables"
    
    # Check wallet_db tables
    local wallet_tables=$(PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_WALLET_HOST -p $POSTGRES_WALLET_PORT \
        -U $POSTGRES_USER -d wallet_db -t -c \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")
    
    echo "   Wallet DB tables: $wallet_tables"
    
    if [ $payment_tables -gt 0 ] && [ $wallet_tables -gt 0 ]; then
        echo -e "${GREEN}✅ Verification successful${NC}"
    else
        echo -e "${RED}❌ Verification failed${NC}"
        return 1
    fi
}

# ============================================================================
# Main Execution
# ============================================================================

main() {
    echo "============================================================================"
    echo "  Payment Processing System - Database Initialization"
    echo "============================================================================"
    
    # Wait for databases to be ready
    wait_for_postgres $POSTGRES_PAYMENT_HOST $POSTGRES_PAYMENT_PORT || exit 1
    wait_for_postgres $POSTGRES_WALLET_HOST $POSTGRES_WALLET_PORT || exit 1
    
    # Initialize databases
    init_payment_db || exit 1
    init_wallet_db || exit 1
    
    # Verify
    verify_installation || exit 1
    
    echo ""
    echo "============================================================================"
    echo -e "${GREEN}🎉 Database initialization complete!${NC}"
    echo "============================================================================"
    echo ""
    echo "Payment Database: postgresql://$POSTGRES_USER@$POSTGRES_PAYMENT_HOST:$POSTGRES_PAYMENT_PORT/payment_db"
    echo "Wallet Database:  postgresql://$POSTGRES_USER@$POSTGRES_WALLET_HOST:$POSTGRES_WALLET_PORT/wallet_db"
    echo ""
}

# Run main function
main
