/**
 * Online Detection Module
 * 
 * Provides reliable online detection that doesn't rely solely on navigator.onLine.
 * Supports custom ping endpoints and user-provided check functions.
 */

import type { OnlineCheckConfig, OnlineCheckFn } from '../types.js';

const DEFAULT_PING_TIMEOUT = 5000;

/**
 * Creates an online checker function based on the provided configuration.
 * 
 * The checker combines multiple signals:
 * 1. navigator.onLine (fast but unreliable)
 * 2. Optional ping endpoint (reliable but slower)
 * 3. Custom check function (user-defined)
 * 
 * @param config Online check configuration
 * @returns Function that returns true if online, false if offline
 */
export function createOnlineChecker(config: OnlineCheckConfig = {}): OnlineCheckFn {
  const { pingUrl, pingTimeout = DEFAULT_PING_TIMEOUT, customCheck } = config;
  
  // If user provided a custom check, use it
  if (customCheck) {
    return customCheck;
  }
  
  // If no ping URL, use navigator.onLine only
  if (!pingUrl) {
    return async () => {
      return typeof navigator !== 'undefined' ? navigator.onLine : true;
    };
  }
  
  // Combine navigator.onLine with ping check
  return async () => {
    // Fast path: if navigator says offline, trust it
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return false;
    }
    
    // Ping the endpoint to confirm connectivity
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), pingTimeout);
      
      const response = await fetch(pingUrl, {
        method: 'HEAD',
        mode: 'no-cors', // Allow cross-origin pings
        cache: 'no-store',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      // In no-cors mode, we can't read the response, but if we get here
      // without an error, the request succeeded
      return response.type === 'opaque' || response.ok;
    } catch (error: unknown) {
      // Any error (network, DNS, timeout, abort) means offline
      return false;
    }
  };
}

/**
 * Check if an error indicates a network failure (vs application error).
 * 
 * This is used to determine if a request should be queued vs reported as failed.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    // Fetch throws TypeError for network errors with specific messages
    const message = error.message.toLowerCase();
    // Check for specific network error patterns from browsers
    return (
      message === 'failed to fetch' ||        // Chrome, Edge
      message === 'network request failed' || // Safari
      message === 'load failed' ||            // Safari
      message === 'networkerror' ||           // Firefox
      message.startsWith('networkerror when') // Firefox detailed
    );
  }
  
  if (error instanceof DOMException) {
    // AbortError from timeout or manual abort
    return error.name === 'AbortError';
  }
  
  return false;
}

/**
 * Check if an HTTP status code indicates a retryable server error.
 * 
 * Returns true for 5xx errors (server errors).
 * Returns false for 4xx errors (client errors - these should not be retried).
 */
export function isRetryableStatusCode(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * Check if an HTTP status code indicates a client error (non-retryable).
 */
export function isClientError(status: number): boolean {
  return status >= 400 && status < 500;
}
