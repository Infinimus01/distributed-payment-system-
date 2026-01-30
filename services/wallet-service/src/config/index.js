require('dotenv').config();

module.exports = {
    // Server
    port: process.env.PORT || 3002,
    nodeEnv: process.env.NODE_ENV || 'development',
    serviceName: process.env.SERVICE_NAME || 'wallet-service',

    // Database
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5433,
        database: process.env.DB_NAME || 'wallet_db',
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
        keyPrefix: process.env.REDIS_KEY_PREFIX || 'wallet:'
    },

    // Wallet Configuration
    wallet: {
        lockTimeoutMs: parseInt(process.env.LOCK_TIMEOUT_MS) || 30000,
        balanceCacheTtl: parseInt(process.env.BALANCE_CACHE_TTL) || 300
    },

    // Logging
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        format: process.env.LOG_FORMAT || 'json'
    }
};
