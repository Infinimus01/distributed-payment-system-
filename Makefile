.PHONY: help install setup start stop clean logs test

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies
	npm install
	npm run install:all

setup: ## Set up environment files
	@echo "Setting up environment files..."
	@cp -n services/api-gateway/.env.example services/api-gateway/.env 2>/dev/null || true
	@cp -n services/payment-service/.env.example services/payment-service/.env 2>/dev/null || true
	@cp -n services/wallet-service/.env.example services/wallet-service/.env 2>/dev/null || true
	@echo "✅ Environment files created"

infra-up: ## Start infrastructure services (PostgreSQL, Redis)
	docker-compose up -d postgres-payment postgres-wallet redis

infra-down: ## Stop infrastructure services
	docker-compose down

infra-logs: ## View infrastructure logs
	docker-compose logs -f postgres-payment postgres-wallet redis

migrate: ## Run database migrations
	npm run migrate:all

dev: ## Start all services in development mode
	npm run dev:all

dev-gateway: ## Start API Gateway in development mode
	npm run dev:gateway

dev-payment: ## Start Payment Service in development mode
	npm run dev:payment

dev-wallet: ## Start Wallet Service in development mode
	npm run dev:wallet

docker-up: ## Start all services with Docker Compose
	docker-compose up --build

docker-down: ## Stop all Docker services
	docker-compose down

docker-logs: ## View all Docker logs
	docker-compose logs -f

test: ## Run tests for all services
	npm run test:all

lint: ## Run linting for all services
	npm run lint:all

clean: ## Remove node_modules and clean up
	npm run clean
	docker-compose down -v

ps: ## Show running Docker containers
	docker-compose ps

health: ## Check health of all services
	@echo "Checking service health..."
	@curl -s http://localhost:3000/health || echo "❌ API Gateway not responding"
	@curl -s http://localhost:3001/health || echo "❌ Payment Service not responding"
	@curl -s http://localhost:3002/health || echo "❌ Wallet Service not responding"

restart: ## Restart all services
	docker-compose restart

rebuild: ## Rebuild and restart all services
	docker-compose up -d --build

status: ## Show status of all services
	@echo "=== Docker Services ==="
	@docker-compose ps
	@echo ""
	@echo "=== Service Health ==="
	@make health
