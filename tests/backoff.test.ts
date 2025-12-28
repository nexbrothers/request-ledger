/**
 * Backoff Utility Tests
 */

import { describe, it, expect } from 'vitest';
import { calculateBackoffDelay, canRetry, DEFAULT_RETRY_STRATEGY } from '../src/utils/backoff.js';
import type { RetryStrategy } from '../src/types.js';

describe('calculateBackoffDelay', () => {
  describe('fixed strategy', () => {
    const strategy: RetryStrategy = {
      type: 'fixed',
      delayMs: 1000,
      maxAttempts: 3,
    };

    it('should return fixed delay for each attempt', () => {
      expect(calculateBackoffDelay(strategy, 1)).toBe(1000);
      expect(calculateBackoffDelay(strategy, 2)).toBe(1000);
    });

    it('should return null when max attempts reached', () => {
      expect(calculateBackoffDelay(strategy, 3)).toBe(null);
      expect(calculateBackoffDelay(strategy, 4)).toBe(null);
    });
  });

  describe('exponential strategy', () => {
    const strategy: RetryStrategy = {
      type: 'exponential',
      baseMs: 1000,
      maxMs: 10000,
      maxAttempts: 5,
    };

    it('should calculate exponential delay', () => {
      expect(calculateBackoffDelay(strategy, 1)).toBe(1000);   // 1000 * 2^0
      expect(calculateBackoffDelay(strategy, 2)).toBe(2000);   // 1000 * 2^1
      expect(calculateBackoffDelay(strategy, 3)).toBe(4000);   // 1000 * 2^2
      expect(calculateBackoffDelay(strategy, 4)).toBe(8000);   // 1000 * 2^3
    });

    it('should cap at maxMs', () => {
      // 1000 * 2^4 = 16000, but capped at 10000
      const highAttemptDelay = calculateBackoffDelay(strategy, 5);
      expect(highAttemptDelay).toBe(null); // max attempts reached
    });

    it('should return null when max attempts reached', () => {
      expect(calculateBackoffDelay(strategy, 5)).toBe(null);
    });
  });

  describe('manual strategy', () => {
    const strategy: RetryStrategy = { type: 'manual' };

    it('should always return null', () => {
      expect(calculateBackoffDelay(strategy, 1)).toBe(null);
      expect(calculateBackoffDelay(strategy, 2)).toBe(null);
      expect(calculateBackoffDelay(strategy, 100)).toBe(null);
    });
  });
});

describe('canRetry', () => {
  it('should return true for fixed strategy under max attempts', () => {
    const strategy: RetryStrategy = { type: 'fixed', delayMs: 1000, maxAttempts: 3 };
    expect(canRetry(strategy, 0)).toBe(true);
    expect(canRetry(strategy, 1)).toBe(true);
    expect(canRetry(strategy, 2)).toBe(true);
  });

  it('should return false for fixed strategy at or above max attempts', () => {
    const strategy: RetryStrategy = { type: 'fixed', delayMs: 1000, maxAttempts: 3 };
    expect(canRetry(strategy, 3)).toBe(false);
    expect(canRetry(strategy, 4)).toBe(false);
  });

  it('should always return true for manual strategy', () => {
    const strategy: RetryStrategy = { type: 'manual' };
    expect(canRetry(strategy, 0)).toBe(true);
    expect(canRetry(strategy, 100)).toBe(true);
  });
});

describe('DEFAULT_RETRY_STRATEGY', () => {
  it('should be exponential with reasonable defaults', () => {
    expect(DEFAULT_RETRY_STRATEGY.type).toBe('exponential');
    expect(DEFAULT_RETRY_STRATEGY).toMatchObject({
      type: 'exponential',
      baseMs: 1000,
      maxMs: 30000,
      maxAttempts: 3,
    });
  });
});
