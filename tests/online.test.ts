/**
 * Online Detection Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createOnlineChecker,
  isNetworkError,
  isRetryableStatusCode,
  isClientError,
} from '../src/online/checker.js';

describe('createOnlineChecker', () => {
  const originalNavigator = global.navigator;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    // Restore navigator
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      configurable: true,
    });
  });

  describe('without ping URL', () => {
    it('should return navigator.onLine value when true', async () => {
      Object.defineProperty(global, 'navigator', {
        value: { onLine: true },
        configurable: true,
      });

      const checker = createOnlineChecker();
      expect(await checker()).toBe(true);
    });

    it('should return navigator.onLine value when false', async () => {
      Object.defineProperty(global, 'navigator', {
        value: { onLine: false },
        configurable: true,
      });

      const checker = createOnlineChecker();
      expect(await checker()).toBe(false);
    });

    it('should return true when navigator is undefined', async () => {
      Object.defineProperty(global, 'navigator', {
        value: undefined,
        configurable: true,
      });

      const checker = createOnlineChecker();
      expect(await checker()).toBe(true);
    });
  });

  describe('with custom check', () => {
    it('should use custom check function', async () => {
      const customCheck = vi.fn().mockResolvedValue(true);
      const checker = createOnlineChecker({ customCheck });

      expect(await checker()).toBe(true);
      expect(customCheck).toHaveBeenCalled();
    });

    it('should return false when custom check returns false', async () => {
      const customCheck = vi.fn().mockResolvedValue(false);
      const checker = createOnlineChecker({ customCheck });

      expect(await checker()).toBe(false);
    });
  });

  describe('with ping URL', () => {
    beforeEach(() => {
      Object.defineProperty(global, 'navigator', {
        value: { onLine: true },
        configurable: true,
      });
    });

    it('should return true when navigator offline', async () => {
      Object.defineProperty(global, 'navigator', {
        value: { onLine: false },
        configurable: true,
      });

      global.fetch = vi.fn();
      const checker = createOnlineChecker({ pingUrl: '/api/ping' });

      // Should return false immediately without pinging
      expect(await checker()).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return true when ping succeeds', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, type: 'basic' });
      const checker = createOnlineChecker({ pingUrl: '/api/ping' });

      expect(await checker()).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should return false when ping fails', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
      const checker = createOnlineChecker({ pingUrl: '/api/ping' });

      expect(await checker()).toBe(false);
    });
  });
});

describe('isNetworkError', () => {
  it('should return true for TypeError with "failed to fetch"', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new TypeError('failed to fetch'))).toBe(true);
  });

  it('should return true for TypeError with "network request failed"', () => {
    expect(isNetworkError(new TypeError('Network request failed'))).toBe(true);
  });

  it('should return true for TypeError with "load failed"', () => {
    expect(isNetworkError(new TypeError('Load failed'))).toBe(true);
  });

  it('should return true for AbortError DOMException', () => {
    const error = new DOMException('Aborted', 'AbortError');
    expect(isNetworkError(error)).toBe(true);
  });

  it('should return false for other errors', () => {
    expect(isNetworkError(new Error('Some other error'))).toBe(false);
    expect(isNetworkError(new TypeError('Cannot read property'))).toBe(false);
    expect(isNetworkError('string error')).toBe(false);
  });
});

describe('isRetryableStatusCode', () => {
  it('should return true for 5xx status codes', () => {
    expect(isRetryableStatusCode(500)).toBe(true);
    expect(isRetryableStatusCode(502)).toBe(true);
    expect(isRetryableStatusCode(503)).toBe(true);
    expect(isRetryableStatusCode(504)).toBe(true);
    expect(isRetryableStatusCode(599)).toBe(true);
  });

  it('should return false for other status codes', () => {
    expect(isRetryableStatusCode(200)).toBe(false);
    expect(isRetryableStatusCode(400)).toBe(false);
    expect(isRetryableStatusCode(404)).toBe(false);
    expect(isRetryableStatusCode(499)).toBe(false);
  });
});

describe('isClientError', () => {
  it('should return true for 4xx status codes', () => {
    expect(isClientError(400)).toBe(true);
    expect(isClientError(401)).toBe(true);
    expect(isClientError(404)).toBe(true);
    expect(isClientError(422)).toBe(true);
    expect(isClientError(499)).toBe(true);
  });

  it('should return false for other status codes', () => {
    expect(isClientError(200)).toBe(false);
    expect(isClientError(500)).toBe(false);
    expect(isClientError(503)).toBe(false);
  });
});
