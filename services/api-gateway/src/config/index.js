require('dotenv').config();

module.exports = {
    // Server
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    serviceName: process.env.SERVICE_NAME || 'api-gateway',

    // Redis
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || '',
        database: parseInt(process.env.REDIS_DB) || 0,
        keyPrefix: process.env.REDIS_KEY_PREFIX || 'gateway:'
    },

    // Rate Limiting
    rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minute
        maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
        blockDurationMs: parseInt(process.env.RATE_LIMIT_BLOCK_DURATION_MS) || 300000 // 5 minutes
    },

    // API Keys
    apiKeys: {
        // In production, these would be stored in a database or secrets manager
        // Format: { apiKey: { name, tier, rateLimit } }
        validKeys: process.env.VALID_API_KEYS ? JSON.parse(process.env.VALID_API_KEYS) : {
            'test_key_merchant_001': {
                name: 'Test Merchant 001',
                tier: 'standard',
                maxRequests: 100
            },
            'test_key_merchant_002': {
                name: 'Test Merchant 002',
                tier: 'premium',
                maxRequests: 1000
            }
        }
    },

    // Downstream Services
    services: {
        paymentService: {
            url: process.env.PAYMENT_SERVICE_URL || 'http://localhost:3001',
            timeout: parseInt(process.env.PAYMENT_SERVICE_TIMEOUT) || 30000
        },
        walletService: {
            url: process.env.WALLET_SERVICE_URL || 'http://localhost:3002',
            timeout: parseInt(process.env.WALLET_SERVICE_TIMEOUT) || 30000
        }
    },

    // Logging
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        format: process.env.LOG_FORMAT || 'json'
    }
};
