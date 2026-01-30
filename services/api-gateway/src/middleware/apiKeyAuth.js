const logger = require('../utils/logger');
const { StatusCodes } = require('http-status-codes');

/**
 * API Key Authentication Middleware
 * 
 * Validates API key from header and attaches key info to request
 */
function apiKeyAuth(validApiKeys) {
    return (req, res, next) => {
        // Extract API key from header
        const apiKey = req.headers['x-api-key'] || req.headers['api-key'];

        if (!apiKey) {
            logger.warn('Missing API key', {
                method: req.method,
                path: req.path,
                ip: req.ip
            });

            return res.status(StatusCodes.UNAUTHORIZED).json({
                success: false,
                error: 'UNAUTHORIZED',
                message: 'API key is required. Please provide X-API-Key header.'
            });
        }

        // Validate API key
        const keyInfo = validApiKeys[apiKey];

        if (!keyInfo) {
            logger.warn('Invalid API key', {
                apiKey: apiKey.substring(0, 10) + '...',
                method: req.method,
                path: req.path,
                ip: req.ip
            });

            return res.status(StatusCodes.UNAUTHORIZED).json({
                success: false,
                error: 'UNAUTHORIZED',
                message: 'Invalid API key'
            });
        }

        // Attach key info to request
        req.apiKey = apiKey;
        req.apiKeyInfo = keyInfo;

        logger.debug('API key validated', {
            apiKey: apiKey.substring(0, 10) + '...',
            name: keyInfo.name,
            tier: keyInfo.tier
        });

        next();
    };
}

module.exports = apiKeyAuth;
