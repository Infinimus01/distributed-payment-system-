const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Service Proxy - Forwards requests to downstream services
 */
class ServiceProxy {
    constructor(serviceConfig) {
        this.serviceConfig = serviceConfig;
        this.clients = {};

        // Create axios clients for each service
        Object.keys(serviceConfig).forEach(serviceName => {
            const config = serviceConfig[serviceName];
            this.clients[serviceName] = axios.create({
                baseURL: config.url,
                timeout: config.timeout,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            // Add request interceptor
            this.clients[serviceName].interceptors.request.use(
                (config) => {
                    logger.debug(`${serviceName} request`, {
                        method: config.method,
                        url: config.url
                    });
                    return config;
                },
                (error) => {
                    logger.error(`${serviceName} request error`, { error: error.message });
                    return Promise.reject(error);
                }
            );

            // Add response interceptor
            this.clients[serviceName].interceptors.response.use(
                (response) => {
                    logger.debug(`${serviceName} response`, {
                        status: response.status
                    });
                    return response;
                },
                (error) => {
                    logger.error(`${serviceName} response error`, {
                        status: error.response?.status,
                        message: error.message
                    });
                    return Promise.reject(error);
                }
            );
        });

        logger.info('Service proxy initialized', {
            services: Object.keys(serviceConfig)
        });
    }

    /**
     * Forward request to payment service
     */
    async forwardToPaymentService(method, path, data = null, headers = {}) {
        return this.forwardRequest('paymentService', method, path, data, headers);
    }

    /**
     * Forward request to wallet service
     */
    async forwardToWalletService(method, path, data = null, headers = {}) {
        return this.forwardRequest('walletService', method, path, data, headers);
    }

    /**
     * Generic request forwarding
     */
    async forwardRequest(serviceName, method, path, data = null, headers = {}) {
        const client = this.clients[serviceName];

        if (!client) {
            throw new Error(`Unknown service: ${serviceName}`);
        }

        logger.info('Forwarding request', {
            service: serviceName,
            method,
            path
        });

        try {
            const config = {
                method: method.toLowerCase(),
                url: path,
                headers: {
                    ...headers,
                    // Remove gateway-specific headers
                    'x-api-key': undefined,
                    'api-key': undefined
                }
            };

            if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
                config.data = data;
            }

            const response = await client.request(config);

            logger.info('Request forwarded successfully', {
                service: serviceName,
                method,
                path,
                status: response.status
            });

            return {
                status: response.status,
                data: response.data,
                headers: response.headers
            };
        } catch (error) {
            if (error.response) {
                // Downstream service returned error response
                logger.warn('Downstream service error', {
                    service: serviceName,
                    method,
                    path,
                    status: error.response.status,
                    error: error.response.data
                });

                return {
                    status: error.response.status,
                    data: error.response.data,
                    headers: error.response.headers
                };
            } else if (error.code === 'ECONNREFUSED') {
                // Service unavailable
                logger.error('Service unavailable', {
                    service: serviceName,
                    method,
                    path,
                    error: error.message
                });

                throw new Error(`SERVICE_UNAVAILABLE: ${serviceName} is not available`);
            } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
                // Timeout
                logger.error('Service timeout', {
                    service: serviceName,
                    method,
                    path,
                    error: error.message
                });

                throw new Error(`SERVICE_TIMEOUT: ${serviceName} request timed out`);
            } else {
                // Other error
                logger.error('Service proxy error', {
                    service: serviceName,
                    method,
                    path,
                    error: error.message,
                    stack: error.stack
                });

                throw error;
            }
        }
    }

    /**
     * Health check for all services
     */
    async healthCheckAll() {
        const results = {};

        for (const serviceName of Object.keys(this.clients)) {
            try {
                const response = await this.clients[serviceName].get('/health', {
                    timeout: 5000
                });
                results[serviceName] = {
                    healthy: response.data.status === 'healthy',
                    status: response.status,
                    data: response.data
                };
            } catch (error) {
                results[serviceName] = {
                    healthy: false,
                    error: error.message
                };
            }
        }

        return results;
    }
}

module.exports = ServiceProxy;
