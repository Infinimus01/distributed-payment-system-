const { Pool } = require('pg');
const logger = require('../utils/logger');

class DatabaseClient {
    constructor(config) {
        this.pool = new Pool({
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
            password: config.password,
            min: config.poolMin,
            max: config.poolMax,
            idleTimeoutMillis: config.idleTimeout,
            connectionTimeoutMillis: config.connectionTimeout
        });

        this.pool.on('error', (err) => {
            logger.error('Unexpected database pool error', { error: err.message, stack: err.stack });
        });

        this.pool.on('connect', () => {
            logger.debug('New database connection established');
        });

        logger.info('Database client initialized', {
            host: config.host,
            port: config.port,
            database: config.database
        });
    }

    async query(text, params = []) {
        const start = Date.now();
        try {
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;
            logger.debug('Query executed', {
                duration,
                rows: result.rowCount,
                query: text.substring(0, 100)
            });
            return result;
        } catch (error) {
            logger.error('Database query error', {
                error: error.message,
                query: text.substring(0, 100),
                stack: error.stack
            });
            throw error;
        }
    }

    async getClient() {
        const client = await this.pool.connect();
        const originalQuery = client.query.bind(client);
        const originalRelease = client.release.bind(client);

        let released = false;

        client.query = async (...args) => {
            if (released) {
                throw new Error('Cannot query on released client');
            }
            return originalQuery(...args);
        };

        client.release = () => {
            if (released) {
                logger.warn('Attempted to release client twice');
                return;
            }
            released = true;
            originalRelease();
            logger.debug('Database client released');
        };

        logger.debug('Database client acquired from pool');
        return client;
    }

    async transaction(callback) {
        const client = await this.getClient();
        try {
            await client.query('BEGIN');
            logger.debug('Transaction started');

            const result = await callback(client);

            await client.query('COMMIT');
            logger.debug('Transaction committed');

            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            logger.warn('Transaction rolled back', { error: error.message });
            throw error;
        } finally {
            client.release();
        }
    }

    async healthCheck() {
        try {
            const result = await this.query('SELECT NOW() as now, version() as version');
            return {
                healthy: true,
                timestamp: result.rows[0].now,
                version: result.rows[0].version
            };
        } catch (error) {
            logger.error('Database health check failed', { error: error.message });
            return { healthy: false, error: error.message };
        }
    }

    async close() {
        await this.pool.end();
        logger.info('Database pool closed');
    }
}

module.exports = DatabaseClient;
