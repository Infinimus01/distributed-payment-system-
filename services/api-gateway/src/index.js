const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const config = require('./config');
const logger = require('./utils/logger');
const RedisClient = require('./infrastructure/cache/RedisClient');
const ServiceProxy = require('./services/ServiceProxy');
const apiKeyAuth = require('./middleware/apiKeyAuth');
const rateLimiter = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');
const PaymentRoutes = require('./routes/paymentRoutes');
const WalletRoutes = require('./routes/walletRoutes');
const { registry: cbRegistry } = require('../shared/resilience/CircuitBreaker');

class App {
    constructor() {
        this.app = express();
        this.redis = null;
        this.serviceProxy = null;
    }

    async initialize() {
        try {
            // Initialize Redis
            this.redis = new RedisClient(config.redis);
            await this.redis.connect();
            const redisHealth = await this.redis.healthCheck();
            if (!redisHealth.healthy) {
                throw new Error('Redis health check failed');
            }
            logger.info('Redis connected successfully');

            // Initialize Service Proxy
            this.serviceProxy = new ServiceProxy(config.services);

            // Initialize route handlers
            const paymentRoutes = new PaymentRoutes(this.serviceProxy);
            const walletRoutes = new WalletRoutes(this.serviceProxy);

            // Setup middleware
            this.setupMiddleware();

            // Setup routes
            this.setupRoutes(paymentRoutes, walletRoutes);

            // Setup error handling
            this.app.use(errorHandler);

            logger.info('Application initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize application', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    setupMiddleware() {
        // Security headers
        this.app.use(helmet({
            crossOriginResourcePolicy: { policy: 'cross-origin' }
        }));

        // CORS — allow any origin (dashboard, Postman, etc.)
        this.app.use(cors({
            origin: '*',
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Idempotency-Key', 'x-idempotency-key']
        }));

        // Compression
        this.app.use(compression());

        // Body parsing
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        // Request logging
        this.app.use((req, res, next) => {
            logger.info('Incoming request', {
                method: req.method,
                path: req.path,
                query: req.query,
                ip: req.ip,
                userAgent: req.headers['user-agent']
            });
            next();
        });

        // API Key Authentication (applied to all /api/* routes)
        this.app.use('/api', apiKeyAuth(config.apiKeys.validKeys));

        // Rate Limiting (applied after auth)
        this.app.use('/api', rateLimiter(this.redis, config));
    }

    setupRoutes(paymentRoutes, walletRoutes) {
        // Health check (no auth required)
        this.app.get('/health', async (req, res) => {
            try {
                const redisHealth = await this.redis.healthCheck();
                const servicesHealth = await this.serviceProxy.healthCheckAll();
                const circuitBreakers = cbRegistry.getAllStats();

                const allHealthy = redisHealth.healthy &&
                    Object.values(servicesHealth).every(s => s.healthy);

                // Circuit breaker mein koi OPEN hai toh degraded
                const anyCircuitOpen = Object.values(circuitBreakers)
                    .some(cb => cb.state === 'OPEN');

                const overallStatus = !allHealthy ? 'unhealthy'
                    : anyCircuitOpen ? 'degraded'
                    : 'healthy';

                res.status(allHealthy ? 200 : 503).json({
                    status: overallStatus,
                    service: config.serviceName,
                    timestamp: new Date().toISOString(),
                    redis: {
                        healthy: redisHealth.healthy,
                        connected: redisHealth.connected
                    },
                    services: servicesHealth,
                    circuitBreakers
                });
            } catch (error) {
                res.status(503).json({
                    status: 'unhealthy',
                    service: config.serviceName,
                    error: error.message
                });
            }
        });

        // API routes (protected by auth + rate limiting)
        const apiRouter = express.Router();

        // Payment routes
        apiRouter.post('/payments', (req, res, next) => {
            paymentRoutes.createPayment(req, res, next);
        });

        apiRouter.post('/payments/:paymentId/process', (req, res, next) => {
            paymentRoutes.processPayment(req, res, next);
        });

        apiRouter.post('/payments/:paymentId/refund', (req, res, next) => {
            paymentRoutes.refundPayment(req, res, next);
        });

        apiRouter.get('/payments/:paymentId', (req, res, next) => {
            paymentRoutes.getPayment(req, res, next);
        });

        apiRouter.get('/payments/user/:userId', (req, res, next) => {
            paymentRoutes.getPaymentsByUser(req, res, next);
        });

        // Wallet routes
        apiRouter.post('/wallets/create', (req, res, next) => walletRoutes.createWallet(req, res, next));
        apiRouter.post('/wallets/debit', (req, res, next) => walletRoutes.debitWallet(req, res, next));
        apiRouter.post('/wallets/credit', (req, res, next) => walletRoutes.creditWallet(req, res, next));
        apiRouter.get('/wallets/:walletId', (req, res, next) => walletRoutes.getWallet(req, res, next));
        apiRouter.get('/wallets/:walletId/transactions', (req, res, next) => walletRoutes.getTransactionHistory(req, res, next));
        apiRouter.get('/wallets/:walletId/reconcile', (req, res, next) => walletRoutes.reconcileBalance(req, res, next));

        this.app.use('/api', apiRouter);

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                success: false,
                error: 'NOT_FOUND',
                message: 'Route not found'
            });
        });
    }

    async start() {
        await this.initialize();

        this.server = this.app.listen(config.port, () => {
            logger.info(`${config.serviceName} listening on port ${config.port}`, {
                environment: config.nodeEnv,
                port: config.port
            });
        });

        // Graceful shutdown
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGINT', () => this.shutdown());
    }

    async shutdown() {
        logger.info('Shutting down gracefully...');

        if (this.server) {
            this.server.close(() => {
                logger.info('HTTP server closed');
            });
        }

        if (this.redis) {
            await this.redis.close();
        }

        process.exit(0);
    }
}

// Start the application
if (require.main === module) {
    const app = new App();
    app.start().catch((error) => {
        logger.error('Failed to start application', {
            error: error.message,
            stack: error.stack
        });
        process.exit(1);
    });
}

module.exports = App;
