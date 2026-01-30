const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const config = require('./config');
const logger = require('./utils/logger');
const DatabaseClient = require('./infrastructure/database/DatabaseClient');
const WalletRepository = require('./infrastructure/repositories/WalletRepository');
const LedgerRepository = require('./infrastructure/repositories/LedgerRepository');
const WalletService = require('./services/WalletService');
const WalletController = require('./controllers/WalletController');
const createWalletRoutes = require('./routes/walletRoutes');
const errorHandler = require('./middleware/errorHandler');

class App {
    constructor() {
        this.app = express();
        this.db = null;
        this.walletService = null;
    }

    /**
     * Initialize database and dependencies
     */
    async initialize() {
        try {
            // Initialize database
            this.db = new DatabaseClient(config.database);

            // Test database connection
            const healthCheck = await this.db.healthCheck();
            if (!healthCheck.healthy) {
                throw new Error('Database health check failed');
            }
            logger.info('Database connected successfully');

            // Initialize repositories
            const walletRepo = new WalletRepository(this.db);
            const ledgerRepo = new LedgerRepository(this.db);

            // Initialize service
            this.walletService = new WalletService(walletRepo, ledgerRepo, this.db);

            // Initialize controller
            const walletController = new WalletController(this.walletService);

            // Setup middleware
            this.setupMiddleware();

            // Setup routes
            this.setupRoutes(walletController);

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

    /**
     * Setup Express middleware
     */
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
                ip: req.ip
            });
            next();
        });
    }

    /**
     * Setup routes
     */
    setupRoutes(walletController) {
        // Health check
        this.app.get('/health', async (req, res) => {
            try {
                const dbHealth = await this.db.healthCheck();

                res.json({
                    status: dbHealth.healthy ? 'healthy' : 'unhealthy',
                    service: config.serviceName,
                    timestamp: new Date().toISOString(),
                    database: {
                        healthy: dbHealth.healthy,
                        timestamp: dbHealth.timestamp
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
        this.app.use('/wallets', createWalletRoutes(walletController));

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                success: false,
                error: 'NOT_FOUND',
                message: 'Route not found'
            });
        });
    }

    /**
     * Start the server
     */
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

    /**
     * Graceful shutdown
     */
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
