/**
 * SmartRetry - Intelligent retry with error classification
 *
 * Key insight: Not all errors should be retried.
 * - Network errors   → RETRY   (transient, will resolve)
 * - Business errors  → ABORT   (retrying wastes time)
 * - Unknown errors   → RETRY with caution
 */

const ErrorType = {
  RETRYABLE: 'RETRYABLE',
  NON_RETRYABLE: 'NON_RETRYABLE',
  UNKNOWN: 'UNKNOWN'
};

const NON_RETRYABLE_PATTERNS = [
  'insufficient_balance',
  'insufficient balance',
  'card_expired',
  'card expired',
  'invalid_card',
  'account_blocked',
  'fraud_detected',
  'wallet_not_found',
  'wallet_not_active',
  'invalid_currency',
  'duplicate_transaction',
  'payment_not_found',
  'invalid_input',
];

const RETRYABLE_PATTERNS = [
  'timeout',
  'network',
  'econnrefused',
  'econnreset',
  'enotfound',
  'etimedout',
  'socket hang up',
  'service unavailable',
  'wallet_service_unavailable',
  'circuit',
  '503',
  '429',
  '502',
];

function classifyError(error) {
  const msg = (error.message || '').toLowerCase();
  const code = (error.code || '').toLowerCase();
  const combined = `${msg} ${code}`;

  if (NON_RETRYABLE_PATTERNS.some((p) => combined.includes(p))) {
    return ErrorType.NON_RETRYABLE;
  }
  if (RETRYABLE_PATTERNS.some((p) => combined.includes(p))) {
    return ErrorType.RETRYABLE;
  }
  return ErrorType.UNKNOWN;
}

async function withSmartRetry(fn, options = {}) {
  const opts = {
    maxAttempts:  options.maxAttempts  ?? 3,
    baseDelayMs:  options.baseDelayMs  ?? 500,
    maxDelayMs:   options.maxDelayMs   ?? 10000,
    jitter:       options.jitter       ?? true,
    context:      options.context      ?? 'operation',
  };

  let lastError = new Error('Unknown error');

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const errorType = classifyError(err);

      console.log(
        `[SmartRetry:${opts.context}] Attempt ${attempt}/${opts.maxAttempts} ` +
        `failed. Type: ${errorType}. Error: ${err.message}`
      );

      // Non-retryable — fail immediately, no point waiting
      if (errorType === ErrorType.NON_RETRYABLE) {
        console.log(`[SmartRetry:${opts.context}] Non-retryable. Aborting.`);
        throw err;
      }

      // Last attempt — give up
      if (attempt === opts.maxAttempts) break;

      // Exponential backoff: 500ms, 1000ms, 2000ms...
      const exponential = opts.baseDelayMs * Math.pow(2, attempt - 1);
      const capped = Math.min(exponential, opts.maxDelayMs);
      // Jitter prevents thundering herd — all retries hit at same time
      const delay = opts.jitter
        ? capped * (0.5 + Math.random() * 0.5)
        : capped;

      console.log(
        `[SmartRetry:${opts.context}] Retrying in ${Math.round(delay)}ms... ` +
        `(attempt ${attempt + 1}/${opts.maxAttempts})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

module.exports = { withSmartRetry, classifyError, ErrorType };
