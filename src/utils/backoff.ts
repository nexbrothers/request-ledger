/**
 * Backoff Utilities
 * 
 * Provides delay calculation for retry strategies.
 */

import type { RetryStrategy } from '../types.js';

/**
 * Calculate the delay before the next retry attempt.
 * 
 * @param strategy The retry strategy configuration
 * @param attemptCount The number of attempts made so far (1-indexed)
 * @returns Delay in milliseconds, or null if max attempts reached
 */
export function calculateBackoffDelay(
  strategy: RetryStrategy,
  attemptCount: number
): number | null {
  switch (strategy.type) {
    case 'fixed': {
      if (attemptCount >= strategy.maxAttempts) {
        return null;
      }
      return strategy.delayMs;
    }
    
    case 'exponential': {
      if (attemptCount >= strategy.maxAttempts) {
        return null;
      }
      // Exponential backoff: baseMs * 2^(attempt-1)
      const delay = strategy.baseMs * Math.pow(2, attemptCount - 1);
      return Math.min(delay, strategy.maxMs);
    }
    
    case 'manual': {
      // Manual strategy never auto-retries
      return null;
    }
  }
}

/**
 * Check if more retry attempts are allowed.
 * 
 * @param strategy The retry strategy configuration
 * @param attemptCount The number of attempts made so far
 * @returns true if more attempts are allowed
 */
export function canRetry(strategy: RetryStrategy, attemptCount: number): boolean {
  if (strategy.type === 'manual') {
    // Manual strategy allows retries but user must trigger them
    return true;
  }
  
  return attemptCount < strategy.maxAttempts;
}

/**
 * Create a promise that resolves after the specified delay.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default retry strategy.
 */
export const DEFAULT_RETRY_STRATEGY: RetryStrategy = {
  type: 'exponential',
  baseMs: 1000,
  maxMs: 30000,
  maxAttempts: 3,
};
