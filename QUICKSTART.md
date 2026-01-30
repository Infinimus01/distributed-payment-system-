# Quick Start Guide

## Prerequisites

Ensure you have the following installed:
- Node.js >= 18.0.0
- Docker and Docker Compose
- npm >= 9.0.0

## Setup Instructions

### 1. Navigate to Project Directory

```bash
cd distributed-payment-system
```

### 2. Install Dependencies

```bash
# Install root dependencies
npm install

# Install all workspace dependencies
npm run install:all
```

### 3. Set Up Environment Variables

For each service, copy the `.env.example` to `.env`:

```bash
# API Gateway
cp services/api-gateway/.env.example services/api-gateway/.env

# Payment Service
cp services/payment-service/.env.example services/payment-service/.env

# Wallet Service
cp services/wallet-service/.env.example services/wallet-service/.env
```

### 4. Start Infrastructure Services

```bash
# Start PostgreSQL and Redis using Docker Compose
docker-compose up -d postgres-payment postgres-wallet redis
```

Wait for services to be healthy:

```bash
# Check service status
docker-compose ps
```

### 5. Run Database Migrations

```bash
# Run migrations for both services (once implemented)
npm run migrate:all
```

### 6. Start Services

**Option A: Start All Services Together**

```bash
npm run dev:all
```

**Option B: Start Services Individually**

```bash
# Terminal 1 - API Gateway
npm run dev:gateway

# Terminal 2 - Payment Service
npm run dev:payment

# Terminal 3 - Wallet Service
npm run dev:wallet
```

### 7. Verify Services

Check health endpoints:

```bash
# API Gateway
curl http://localhost:3000/health

# Payment Service
curl http://localhost:3001/health

# Wallet Service
curl http://localhost:3002/health
```

## Using Docker Compose (Full Stack)

To run everything in Docker:

```bash
# Build and start all services
docker-compose up --build

# Run in detached mode
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

## Development Workflow

### Running Tests

```bash
# Run tests for all services
npm run test:all

# Run tests for specific service
cd services/payment-service && npm test
```

### Linting

```bash
# Lint all services
npm run lint:all
```

### Cleaning Up

```bash
# Remove node_modules from all services
npm run clean

# Stop and remove Docker containers
docker-compose down -v
```

## Service URLs

Once running, services are available at:

- **API Gateway**: http://localhost:3000
- **Payment Service**: http://localhost:3001
- **Wallet Service**: http://localhost:3002

## Troubleshooting

### Port Already in Use

If you get port conflicts:

```bash
# Find and kill process using port 3000
lsof -ti:3000 | xargs kill -9

# Or change ports in .env files
```

### Database Connection Issues

```bash
# Check if PostgreSQL is running
docker-compose ps postgres-payment postgres-wallet

# View PostgreSQL logs
docker-compose logs postgres-payment
```

### Redis Connection Issues

```bash
# Check if Redis is running
docker-compose ps redis

# Test Redis connection
docker-compose exec redis redis-cli ping
```

## Next Steps

1. Review `DESIGN.md` for architecture details
2. Review `STRUCTURE.md` for project layout
3. Start implementing business logic in each service
4. Add database migrations
5. Implement API endpoints

## Useful Commands

```bash
# View all running containers
docker-compose ps

# Restart a specific service
docker-compose restart payment-service

# View logs for specific service
docker-compose logs -f api-gateway

# Execute command in container
docker-compose exec payment-service sh

# Rebuild specific service
docker-compose up -d --build payment-service
```
