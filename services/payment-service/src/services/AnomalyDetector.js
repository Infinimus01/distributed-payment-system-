const logger = require('../utils/logger');

/**
 * AnomalyDetector - Rule-based fraud detection
 *
 * Real fintech pain point:
 * - Same user making 10 payments in 30 seconds = card testing attack
 * - Unusually large payment = account takeover
 * - Multiple failed payments = brute force attempt
 *
 * Rules:
 * 1. VELOCITY: > 5 payments from same user in 60 seconds
 * 2. LARGE_AMOUNT: single payment > 5000 (configurable)
 * 3. FAILED_STREAK: > 3 consecutive failures from same user
 * 4. DUPLICATE_AMOUNT: same amount, same user, 3 times in 5 minutes
 */
class AnomalyDetector {
  constructor(redisClient, config = {}) {
    this.redis = redisClient;
    this.rules = {
      velocityLimit:     config.velocityLimit     ?? 5,
      velocityWindowSec: config.velocityWindowSec ?? 60,
      largeAmountThreshold: config.largeAmountThreshold ?? 5000,
      failedStreakLimit: config.failedStreakLimit  ?? 3,
      duplicateWindowSec: config.duplicateWindowSec ?? 300,
      duplicateCountLimit: config.duplicateCountLimit ?? 3,
    };
  }

  /**
   * Check payment for anomalies before processing
   * Returns { flagged: bool, reason: string, severity: string }
   */
  async check(payment) {
    const checks = await Promise.all([
      this._checkVelocity(payment),
      this._checkLargeAmount(payment),
      this._checkFailedStreak(payment),
      this._checkDuplicateAmount(payment),
    ]);

    const flagged = checks.filter(c => c.flagged);

    if (flagged.length > 0) {
      const highest = flagged.sort((a, b) =>
        this._severityScore(b.severity) - this._severityScore(a.severity)
      )[0];

      logger.warn('ANOMALY DETECTED', {
        paymentId: payment.id,
        userId: payment.userId,
        amount: payment.amount,
        flags: flagged.map(f => f.reason),
        severity: highest.severity,
      });

      return {
        flagged: true,
        reason: flagged.map(f => f.reason).join(', '),
        severity: highest.severity,
        flags: flagged,
      };
    }

    return { flagged: false };
  }

  /**
   * Record payment attempt — call this after every payment create
   */
  async record(payment) {
    const now = Date.now();
    const userId = payment.userId;

    await Promise.all([
      // Velocity tracking
      this._redisRpush(`anomaly:velocity:${userId}`, now, this.rules.velocityWindowSec * 2),
      // Failed streak tracking (only if failed)
      payment.status === 'FAILED'
        ? this._redisIncr(`anomaly:failed:${userId}`, this.rules.velocityWindowSec * 5)
        : this.redis.del(`anomaly:failed:${userId}`),
      // Duplicate amount tracking
      this._redisRpush(
        `anomaly:amount:${userId}:${payment.amount}`,
        now,
        this.rules.duplicateWindowSec * 2
      ),
    ]);
  }

  async _checkVelocity(payment) {
    const key = `anomaly:velocity:${payment.userId}`;
    const windowMs = this.rules.velocityWindowSec * 1000;
    const now = Date.now();

    try {
      const timestamps = await this.redis.lrange(key, 0, -1);
      const recent = (timestamps || [])
        .map(Number)
        .filter(t => now - t < windowMs);

      if (recent.length >= this.rules.velocityLimit) {
        return {
          flagged: true,
          reason: `VELOCITY_EXCEEDED: ${recent.length} payments in ${this.rules.velocityWindowSec}s`,
          severity: 'HIGH',
        };
      }
    } catch (err) {
      logger.warn('Velocity check failed', { error: err.message });
    }

    return { flagged: false };
  }

  async _checkLargeAmount(payment) {
    if (payment.amount > this.rules.largeAmountThreshold) {
      return {
        flagged: true,
        reason: `LARGE_AMOUNT: ${payment.amount} exceeds threshold ${this.rules.largeAmountThreshold}`,
        severity: 'MEDIUM',
      };
    }
    return { flagged: false };
  }

  async _checkFailedStreak(payment) {
    const key = `anomaly:failed:${payment.userId}`;
    try {
      const count = await this.redis.get(key);
      if (parseInt(count || 0) >= this.rules.failedStreakLimit) {
        return {
          flagged: true,
          reason: `FAILED_STREAK: ${count} consecutive failures`,
          severity: 'HIGH',
        };
      }
    } catch (err) {
      logger.warn('Failed streak check error', { error: err.message });
    }
    return { flagged: false };
  }

  async _checkDuplicateAmount(payment) {
    const key = `anomaly:amount:${payment.userId}:${payment.amount}`;
    const windowMs = this.rules.duplicateWindowSec * 1000;
    const now = Date.now();

    try {
      const timestamps = await this.redis.lrange(key, 0, -1);
      const recent = (timestamps || [])
        .map(Number)
        .filter(t => now - t < windowMs);

      if (recent.length >= this.rules.duplicateCountLimit) {
        return {
          flagged: true,
          reason: `DUPLICATE_AMOUNT: same amount ${payment.amount} sent ${recent.length} times in ${this.rules.duplicateWindowSec}s`,
          severity: 'MEDIUM',
        };
      }
    } catch (err) {
      logger.warn('Duplicate amount check error', { error: err.message });
    }

    return { flagged: false };
  }

  async _redisRpush(key, value, ttlSec) {
    try {
      await this.redis.rpush(key, value.toString());
      await this.redis.expire(key, ttlSec);
    } catch (err) {
      logger.warn('Redis rpush failed', { key, error: err.message });
    }
  }

  async _redisIncr(key, ttlSec) {
    try {
      await this.redis.incr(key);
      await this.redis.expire(key, ttlSec);
    } catch (err) {
      logger.warn('Redis incr failed', { key, error: err.message });
    }
  }

  _severityScore(severity) {
    return { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[severity] || 0;
  }
}

module.exports = AnomalyDetector;
