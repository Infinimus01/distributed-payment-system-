const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const config = require('./config');
const logger = require('./utils/logger');
const DatabaseClient = require('./infrastructure/database/DatabaseClient');
const RedisClient = require('./infrastructure/cache/RedisClient');
const WalletClient = require('./infrastructure/clients/WalletClient');
const PaymentRepository = require('./infrastructure/repositories/PaymentRepository');
const IdempotencyService = require('./services/IdempotencyService');
const EventPublisher = require('./services/EventPublisher');
const PaymentService = require('./services/PaymentService');
const PaymentProcessor = require('./services/PaymentProcessor');
const PaymentController = require('./controllers/PaymentController');
const createPaymentRoutes = require('./routes/paymentRoutes');
const errorHandler = require('./middleware/errorHandler');

class App {
    constructor() {
        this.app = express();
        this.db = null;
        this.redis = null;
        this.walletClient = null;
        this.paymentService = null;
        this.paymentProcessor = null;
    }

    async initialize() {
        try {
            // Initialize database
            this.db = new DatabaseClient(config.database);
            const dbHealth = await this.db.healthCheck();
            if (!dbHealth.healthy) {
                throw new Error('Database health check failed');
            }
            logger.info('Database connected successfully');

            // Initialize Redis
            this.redis = new RedisClient(config.redis);
            await this.redis.connect();
            const redisHealth = await this.redis.healthCheck();
            if (!redisHealth.healthy) {
                throw new Error('Redis health check failed');
            }
            logger.info('Redis connected successfully');

            // Initialize Wallet Client
            this.walletClient = new WalletClient(
                config.services.walletServiceUrl,
                config.services.paymentGatewayTimeout
            );
            logger.info('Wallet client initialized', {
                walletServiceUrl: config.services.walletServiceUrl
            });

            // Initialize repositories and services
            const paymentRepo = new PaymentRepository(this.db);
            const idempotencyService = new IdempotencyService(
                this.redis,
                config.payment.idempotencyKeyTtl
            );
            const eventPublisher = new EventPublisher(this.redis);

            // Initialize payment service
            this.paymentService = new PaymentService(
                paymentRepo,
                idempotencyService,
                eventPublisher,
                this.db
            );

            // Initialize payment processor
            this.paymentProcessor = new PaymentProcessor(
                this.paymentService,
                this.walletClient,
                config
            );

            // Initialize controller
            const paymentController = new PaymentController(
                this.paymentService,
                this.paymentProcessor
            );

            // Setup middleware
            this.setupMiddleware();

            // Setup routes
            this.setupRoutes(paymentController);

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
        this.app.use(helmet());

        // CORS
        this.app.use(cors());

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
                idempotencyKey: req.headers['idempotency-key'] || req.headers['x-idempotency-key'],
                ip: req.ip
            });
            next();
        });
    }

    setupRoutes(paymentController) {
        // Health check
        this.app.get('/health', async (req, res) => {
            try {
                const dbHealth = await this.db.healthCheck();
                const redisHealth = await this.redis.healthCheck();
                const walletHealth = await this.walletClient.healthCheck();

                const isHealthy = dbHealth.healthy && redisHealth.healthy && walletHealth;

                res.status(isHealthy ? 200 : 503).json({
                    status: isHealthy ? 'healthy' : 'unhealthy',
                    service: config.serviceName,
                    timestamp: new Date().toISOString(),
                    database: {
                        healthy: dbHealth.healthy,
                        timestamp: dbHealth.timestamp
                    },
                    redis: {
                        healthy: redisHealth.healthy,
                        connected: redisHealth.connected
                    },
                    walletService: {
                        healthy: walletHealth
                    }
                });
            } catch (error) {
                res.status(503).json({
                    status: 'unhealthy',
                    service: config.serviceName,
                    error: error.message
                });
            }
        });

        // API routes
        this.app.use('/payments', createPaymentRoutes(paymentController));

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

        if (this.db) {
            await this.db.close();
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
