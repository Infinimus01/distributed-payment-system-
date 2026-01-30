const winston = require('winston');
const config = require('../config');

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    config.logging.format === 'json'
        ? winston.format.json()
        : winston.format.printf(({ timestamp, level, message, ...meta }) => {
            let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
            if (Object.keys(meta).length > 0) {
                msg += ` ${JSON.stringify(meta)}`;
            }
            return msg;
        })
);

const logger = winston.createLogger({
    level: config.logging.level,
    format: logFormat,
    defaultMeta: { service: config.serviceName },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        })
    ]
});

logger.child = (context) => {
    return logger.child(context);
};

module.exports = logger;
