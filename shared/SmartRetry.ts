export type RetryErrorType =
  | 'RETRYABLE'       // Network error, timeout — retry karo
  | 'NON_RETRYABLE'   // Insufficient funds, card expired — retry mat karo
  | 'UNKNOWN';

export function classifyError(error: Error): RetryErrorType {
  const msg = error.message.toLowerCase();

  const nonRetryable = [
    'insufficient funds',
    'card expired',
    'invalid card',
    'account blocked',
    'fraud detected',
    'invalid currency',
    'duplicate transaction',
  ];

  const retryable = [
    'timeout',
    'network',
    'econnrefused',
    'econnreset',
    'service unavailable',
    'circuit',
    '503',
    '429',
  ];

  if (nonRetryable.some((k) => msg.includes(k))) return 'NON_RETRYABLE';
  if (retryable.some((k) => msg.includes(k))) return 'RETRYABLE';
  return 'UNKNOWN';
}

interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export async function withSmartRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts: RetryOptions = {
    maxAttempts: options.maxAttempts ?? 3,
    baseDelayMs: options.baseDelayMs ?? 500,
    maxDelayMs: options.maxDelayMs ?? 10000,
    jitter: options.jitter ?? true,
  };

  let lastError: Error = new Error('Unknown error');

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      const errorType = classifyError(lastError);

      console.log(`[SmartRetry] Attempt ${attempt}/${opts.maxAttempts} failed. Type: ${errorType}. Error: ${lastError.message}`);

      // NON_RETRYABLE — immediately throw, retry karna bakwaas hai
      if (errorType === 'NON_RETRYABLE') {
        console.log(`[SmartRetry] Non-retryable error. Aborting.`);
        throw lastError;
      }

      // Last attempt — throw karo
      if (attempt === opts.maxAttempts) break;

      // Exponential backoff with optional jitter
      const exponentialDelay = opts.baseDelayMs * Math.pow(2, attempt - 1);
      const cappedDelay = Math.min(exponentialDelay, opts.maxDelayMs);
      const finalDelay = opts.jitter
        ? cappedDelay * (0.5 + Math.random() * 0.5)
        : cappedDelay;

      console.log(`[SmartRetry] Retrying in ${Math.round(finalDelay)}ms...`);
      await new Promise((r) => setTimeout(r, finalDelay));
    }
  }

  throw lastError;
}
