const { createClient } = require('redis');
const logger = require('../../utils/logger');

class RedisClient {
    constructor(config) {
        this.config = config;
        this.client = null;
        this.isConnected = false;
    }

    async connect() {
        try {
            this.client = createClient({
                socket: {
                    host: this.config.host,
                    port: this.config.port,
                    reconnectStrategy: (retries) => {
                        if (retries > 10) {
                            logger.error('Redis reconnection attempts exhausted');
                            return new Error('Redis reconnection failed');
                        }
                        const delay = Math.min(retries * 100, 3000);
                        logger.info(`Reconnecting to Redis in ${delay}ms...`);
                        return delay;
                    }
                },
                password: this.config.password || undefined,
                database: this.config.database || 0
            });

            this.client.on('error', (err) => {
                logger.error('Redis client error', { error: err.message });
                this.isConnected = false;
            });

            this.client.on('connect', () => {
                logger.info('Redis client connected');
                this.isConnected = true;
            });

            this.client.on('ready', () => {
                logger.info('Redis client ready');
            });

            this.client.on('reconnecting', () => {
                logger.warn('Redis client reconnecting');
            });

            await this.client.connect();
            logger.info('Redis initialized', {
                host: this.config.host,
                port: this.config.port
            });
            return this.client;
        } catch (error) {
            logger.error('Failed to connect to Redis', { error: error.message });
            throw error;
        }
    }

    async get(key) {
        const prefixedKey = this.getPrefixedKey(key);
        try {
            const value = await this.client.get(prefixedKey);
            return value ? JSON.parse(value) : null;
        } catch (error) {
            logger.error('Redis GET error', { key: prefixedKey, error: error.message });
            throw error;
        }
    }

    async set(key, value, ttlSeconds = null) {
        const prefixedKey = this.getPrefixedKey(key);
        try {
            const serialized = JSON.stringify(value);
            if (ttlSeconds) {
                await this.client.setEx(prefixedKey, ttlSeconds, serialized);
            } else {
                await this.client.set(prefixedKey, serialized);
            }
            logger.debug('Redis SET', { key: prefixedKey, ttl: ttlSeconds });
        } catch (error) {
            logger.error('Redis SET error', { key: prefixedKey, error: error.message });
            throw error;
        }
    }

    async incr(key) {
        const prefixedKey = this.getPrefixedKey(key);
        try {
            const value = await this.client.incr(prefixedKey);
            return value;
        } catch (error) {
            logger.error('Redis INCR error', { key: prefixedKey, error: error.message });
            throw error;
        }
    }

    async expire(key, ttlSeconds) {
        const prefixedKey = this.getPrefixedKey(key);
        try {
            await this.client.expire(prefixedKey, ttlSeconds);
        } catch (error) {
            logger.error('Redis EXPIRE error', { key: prefixedKey, error: error.message });
            throw error;
        }
    }

    async ttl(key) {
        const prefixedKey = this.getPrefixedKey(key);
        try {
            return await this.client.ttl(prefixedKey);
        } catch (error) {
            logger.error('Redis TTL error', { key: prefixedKey, error: error.message });
            throw error;
        }
    }

    async del(key) {
        const prefixedKey = this.getPrefixedKey(key);
        try {
            await this.client.del(prefixedKey);
            logger.debug('Redis DEL', { key: prefixedKey });
        } catch (error) {
            logger.error('Redis DEL error', { key: prefixedKey, error: error.message });
            throw error;
        }
    }

    getPrefixedKey(key) {
        return `${this.config.keyPrefix || ''}${key}`;
    }

    async healthCheck() {
        try {
            const pong = await this.client.ping();
            return { healthy: pong === 'PONG', connected: this.isConnected };
        } catch (error) {
            logger.error('Redis health check failed', { error: error.message });
            return { healthy: false, connected: false, error: error.message };
        }
    }

    async close() {
        if (this.client) {
            await this.client.quit();
            logger.info('Redis client closed');
        }
    }
}

module.exports = RedisClient;
