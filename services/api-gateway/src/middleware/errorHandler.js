const logger = require('../utils/logger');
const { StatusCodes } = require('http-status-codes');

/**
 * Global error handler middleware
 */
function errorHandler(err, req, res, next) {
    logger.error('Request error', {
        error: err.message,
        stack: err.stack,
        method: req.method,
        path: req.path,
        apiKey: req.apiKey ? req.apiKey.substring(0, 10) + '...' : 'none'
    });

    // Handle service unavailable errors
    if (err.message && err.message.startsWith('SERVICE_UNAVAILABLE')) {
        return res.status(StatusCodes.SERVICE_UNAVAILABLE).json({
            success: false,
            error: 'SERVICE_UNAVAILABLE',
            message: 'Downstream service is currently unavailable. Please try again later.'
        });
    }

    // Handle service timeout errors
    if (err.message && err.message.startsWith('SERVICE_TIMEOUT')) {
        return res.status(StatusCodes.GATEWAY_TIMEOUT).json({
            success: false,
            error: 'GATEWAY_TIMEOUT',
            message: 'Request to downstream service timed out. Please try again.'
        });
    }

    // Handle axios errors
    if (err.isAxiosError) {
        return res.status(StatusCodes.BAD_GATEWAY).json({
            success: false,
            error: 'BAD_GATEWAY',
            message: 'Error communicating with downstream service'
        });
    }

    // Default internal server error
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred'
    });
}

module.exports = errorHandler;
