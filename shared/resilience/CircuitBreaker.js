/**
 * CircuitBreaker - Prevents cascading failures
 * 
 * States:
 * CLOSED   → Normal operation, calls go through
 * OPEN     → Failing fast, no calls made
 * HALF_OPEN → Testing if service recovered
 */

const CircuitState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.totalCalls = 0;
    this.totalFailures = 0;

    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      recoveryTimeout: options.recoveryTimeout ?? 30000,
      successThreshold: options.successThreshold ?? 2,
      timeout: options.timeout ?? 10000,
    };
  }

  async execute(fn) {
    this.totalCalls++;

    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      const elapsed = now - (this.lastFailureTime ?? 0);

      if (elapsed < this.options.recoveryTimeout) {
        const retryAfter = Math.ceil((this.options.recoveryTimeout - elapsed) / 1000);
        throw new Error(
          `Circuit [${this.name}] is OPEN. Retry after ${retryAfter}s`
        );
      }

      console.log(`[CircuitBreaker:${this.name}] OPEN -> HALF_OPEN`);
      this.state = CircuitState.HALF_OPEN;
      this.successes = 0;
    }

    try {
      const result = await this._executeWithTimeout(fn);
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _executeWithTimeout(fn) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `Circuit [${this.name}] call timed out after ${this.options.timeout}ms`
        ));
      }, this.options.timeout);

      fn()
        .then((result) => { clearTimeout(timer); resolve(result); })
        .catch((err)   => { clearTimeout(timer); reject(err); });
    });
  }

  _onSuccess() {
    this.failures = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.options.successThreshold) {
        console.log(`[CircuitBreaker:${this.name}] HALF_OPEN -> CLOSED`);
        this.state = CircuitState.CLOSED;
        this.successes = 0;
      }
    }
  }

  _onFailure() {
    this.failures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (
      this.state === CircuitState.HALF_OPEN ||
      this.failures >= this.options.failureThreshold
    ) {
      console.log(
        `[CircuitBreaker:${this.name}] -> OPEN (failures: ${this.failures})`
      );
      this.state = CircuitState.OPEN;
    }
  }

  getStats() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      lastFailureTime: this.lastFailureTime,
      uptime: this.state === CircuitState.CLOSED ? '100%' :
              this.state === CircuitState.OPEN ? '0%' : 'recovering'
    };
  }

  isOpen() { return this.state === CircuitState.OPEN; }
  getState() { return this.state; }
}

// Singleton registry — ek hi instance per service name
class CircuitBreakerRegistry {
  constructor() {
    this.breakers = new Map();
  }

  get(name, options = {}) {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker(name, options));
    }
    return this.breakers.get(name);
  }

  getAllStats() {
    const stats = {};
    this.breakers.forEach((breaker, name) => {
      stats[name] = breaker.getStats();
    });
    return stats;
  }
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitState,
  registry: new CircuitBreakerRegistry()
};
