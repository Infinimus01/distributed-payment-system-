const logger = require('../utils/logger');
const { StatusCodes } = require('http-status-codes');

/**
 * Global error handler middleware
 */
function errorHandler(err, req, res, next) {
    // Log error
    logger.error('Request error', {
        error: err.message,
        stack: err.stack,
        method: req.method,
        path: req.path,
        body: req.body
    });

    // Handle known errors
    const errorMap = {
        'WALLET_NOT_FOUND': {
            status: StatusCodes.NOT_FOUND,
            message: 'Wallet not found'
        },
        'WALLET_ALREADY_EXISTS': {
            status: StatusCodes.CONFLICT,
            message: 'Wallet already exists for this user and currency'
        },
        'INSUFFICIENT_BALANCE': {
            status: StatusCodes.UNPROCESSABLE_ENTITY,
            message: 'Insufficient balance'
        },
        'WALLET_NOT_ACTIVE': {
            status: StatusCodes.FORBIDDEN,
            message: 'Wallet is not active'
        },
        'CONCURRENT_MODIFICATION': {
            status: StatusCodes.CONFLICT,
            message: 'Concurrent modification detected, please retry'
        },
        'DUPLICATE_LEDGER_ENTRY': {
            status: StatusCodes.CONFLICT,
            message: 'Duplicate transaction detected'
        }
    };

    // Check if it's a known error
    const errorCode = err.message.split(':')[0];
    const knownError = errorMap[errorCode];

    if (knownError) {
        return res.status(knownError.status).json({
            success: false,
            error: errorCode,
            message: knownError.message
        });
    }

    // Handle validation errors
    if (err.message.startsWith('INVALID_INPUT')) {
        return res.status(StatusCodes.BAD_REQUEST).json({
            success: false,
            error: 'INVALID_INPUT',
            message: err.message.replace('INVALID_INPUT: ', '')
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
