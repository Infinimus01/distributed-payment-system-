require('dotenv').config();

module.exports = {
    // Server
    port: process.env.PORT || 3001,
    nodeEnv: process.env.NODE_ENV || 'development',
    serviceName: process.env.SERVICE_NAME || 'payment-service',

    // Database
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'payment_db',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        poolMin: parseInt(process.env.DB_POOL_MIN) || 2,
        poolMax: parseInt(process.env.DB_POOL_MAX) || 10,
        idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
        connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 2000
    },

    // Redis
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || '',
        database: parseInt(process.env.REDIS_DB) || 0,
        keyPrefix: process.env.REDIS_KEY_PREFIX || 'payment:'
    },

    // Payment Processing
    payment: {
        timeoutMs: parseInt(process.env.PAYMENT_TIMEOUT_MS) || 30000,
        maxRetryAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3,
        retryDelayMs: parseInt(process.env.RETRY_DELAY_MS) || 1000,
        idempotencyKeyTtl: parseInt(process.env.IDEMPOTENCY_KEY_TTL) || 86400 // 24 hours
    },

    // External Services
    services: {
        walletServiceUrl: process.env.WALLET_SERVICE_URL || 'http://localhost:3002',
        paymentGatewayUrl: process.env.PAYMENT_GATEWAY_URL || 'http://localhost:4000',
        paymentGatewayApiKey: process.env.PAYMENT_GATEWAY_API_KEY || 'test-api-key',
        paymentGatewayTimeout: parseInt(process.env.PAYMENT_GATEWAY_TIMEOUT) || 10000
    },

    // Logging
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        format: process.env.LOG_FORMAT || 'json'
    }
};
