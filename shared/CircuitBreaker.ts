export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

interface CircuitBreakerOptions {
  failureThreshold: number;
  recoveryTimeout: number;
  successThreshold: number;
  timeout: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private lastFailureTime: number | null = null;
  private totalCalls: number = 0;
  private totalFailures: number = 0;
  private readonly options: CircuitBreakerOptions;
  private readonly name: string;

  constructor(name: string, options: Partial<CircuitBreakerOptions> = {}) {
    this.name = name;
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      recoveryTimeout: options.recoveryTimeout ?? 30000,
      successThreshold: options.successThreshold ?? 2,
      timeout: options.timeout ?? 10000,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      const timeSinceLastFailure = now - (this.lastFailureTime ?? 0);

      if (timeSinceLastFailure < this.options.recoveryTimeout) {
        throw new Error(
          `Circuit [${this.name}] OPEN. Retry after ${
            Math.ceil((this.options.recoveryTimeout - timeSinceLastFailure) / 1000)
          }s`
        );
      }

      console.log(`[CB:${this.name}] OPEN -> HALF_OPEN`);
      this.state = CircuitState.HALF_OPEN;
      this.successes = 0;
    }

    try {
      const result = await this.executeWithTimeout(fn);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Circuit [${this.name}] call timed out after ${this.options.timeout}ms`));
      }, this.options.timeout);

      fn()
        .then((result) => { clearTimeout(timer); resolve(result); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  private onSuccess(): void {
    this.failures = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.options.successThreshold) {
        console.log(`[CB:${this.name}] HALF_OPEN -> CLOSED`);
        this.state = CircuitState.CLOSED;
        this.successes = 0;
      }
    }
  }

  private onFailure(): void {
    this.failures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (
      this.state === CircuitState.HALF_OPEN ||
      this.failures >= this.options.failureThreshold
    ) {
      console.log(`[CB:${this.name}] -> OPEN (failures: ${this.failures})`);
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
    };
  }

  getState(): CircuitState { return this.state; }
  isOpen(): boolean { return this.state === CircuitState.OPEN; }
}

// Singleton registry — ek hi jagah se saare breakers manage karo
export class CircuitBreakerRegistry {
  private static breakers: Map<string, CircuitBreaker> = new Map();

  static get(name: string, options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker(name, options));
    }
    return this.breakers.get(name)!;
  }

  static getAllStats() {
    const stats: Record<string, object> = {};
    this.breakers.forEach((breaker, name) => {
      stats[name] = breaker.getStats();
    });
    return stats;
  }
}
