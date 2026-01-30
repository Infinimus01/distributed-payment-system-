# Project Structure

```
distributed-payment-system/
│
├── README.md                          # Project overview and setup instructions
├── DESIGN.md                          # Architecture and design decisions
├── package.json                       # Root package.json with workspace config
├── docker-compose.yml                 # Docker orchestration for all services
├── .gitignore                         # Git ignore rules
│
├── services/                          # Microservices
│   │
│   ├── api-gateway/                   # API Gateway Service (Port 3000)
│   │   ├── package.json               # Dependencies and scripts
│   │   ├── .env.example               # Environment variables template
│   │   ├── Dockerfile                 # Container configuration
│   │   └── src/
│   │       └── index.js               # Entry point (placeholder)
│   │
│   ├── payment-service/               # Payment Service (Port 3001)
│   │   ├── package.json               # Dependencies and scripts
│   │   ├── .env.example               # Environment variables template
│   │   ├── Dockerfile                 # Container configuration
│   │   └── src/
│   │       └── index.js               # Entry point (placeholder)
│   │
│   └── wallet-service/                # Wallet Service (Port 3002)
│       ├── package.json               # Dependencies and scripts
│       ├── .env.example               # Environment variables template
│       ├── Dockerfile                 # Container configuration
│       └── src/
│           └── index.js               # Entry point (placeholder)
│
├── shared/                            # Shared code across services
│   ├── package.json                   # Shared package config
│   ├── index.js                       # Main export file
│   ├── events/
│   │   └── PaymentEvents.js           # Event type definitions
│   └── types/
│       ├── enums.js                   # Shared enums (Status, Currency, etc.)
│       └── errors.js                  # Error codes
│
└── infrastructure/                    # Infrastructure configs
    └── README.md                      # Infrastructure documentation
```

## Service Ports

- **API Gateway**: 3000
- **Payment Service**: 3001
- **Wallet Service**: 3002
- **PostgreSQL (Payment)**: 5432
- **PostgreSQL (Wallet)**: 5433
- **Redis**: 6379

## Database Separation

- **payment_db** (Port 5432): Used by Payment Service
- **wallet_db** (Port 5433): Used by Wallet Service

## Next Steps

1. Implement business logic for each service
2. Add database migrations
3. Implement API routes and controllers
4. Add middleware (auth, logging, error handling)
5. Implement inter-service communication
6. Add comprehensive tests
7. Set up CI/CD pipelines
