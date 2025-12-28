/**
 * Replay Engine
 * 
 * Handles the ordered processing of queued requests.
 * Ensures crash-safety and deterministic processing.
 */

import type {
  LedgerEntry,
  LedgerStorage,
  ProcessOptions,
  RetryStrategy,
  LedgerHooks,
  OnlineCheckFn,
  LedgerState,
} from '../types.js';
import { NetworkError } from '../types.js';
import { isNetworkError, isRetryableStatusCode, isClientError } from '../online/checker.js';
import { calculateBackoffDelay, delay, DEFAULT_RETRY_STRATEGY } from '../utils/backoff.js';

const DEFAULT_IDEMPOTENCY_HEADER = 'X-Idempotency-Key';

export interface ReplayEngineConfig {
  storage: LedgerStorage;
  onlineCheck: OnlineCheckFn;
  retry: RetryStrategy;
  hooks: LedgerHooks;
  idempotencyHeader: string;
}

/**
 * The replay engine processes queued requests in order.
 * 
 * Key behaviors:
 * - Processes entries in insertion order (by createdAt)
 * - Single processing loop at a time (no parallel process() calls)
 * - Crash-safe: marks stale 'processing' entries as 'pending' on start
 * - Respects concurrency limit
 * - Stops on first error if stopOnError is true
 */
export class ReplayEngine {
  private readonly storage: LedgerStorage;
  private readonly onlineCheck: OnlineCheckFn;
  private readonly retry: RetryStrategy;
  private readonly hooks: LedgerHooks;
  private readonly idempotencyHeader: string;
  
  private isProcessing = false;
  private isPaused = false;
  private lastError: Error | null = null;
  private abortController: AbortController | null = null;

  constructor(config: ReplayEngineConfig) {
    this.storage = config.storage;
    this.onlineCheck = config.onlineCheck;
    this.retry = config.retry;
    this.hooks = config.hooks;
    this.idempotencyHeader = config.idempotencyHeader;
  }

  /**
   * Get the current state of the replay engine.
   */
  async getState(): Promise<LedgerState> {
    if (this.isPaused) {
      return 'paused';
    }
    
    if (this.isProcessing) {
      return 'processing';
    }
    
    if (this.lastError) {
      return 'error';
    }
    
    const entries = await this.storage.getAll();
    const hasPending = entries.some(e => e.status === 'pending' || e.status === 'processing');
    
    return hasPending ? 'pending' : 'idle';
  }

  /**
   * Process pending entries in the queue.
   * 
   * @param options Processing options
   */
  async process(options: ProcessOptions = {}): Promise<void> {
    const {
      concurrency = 1,
      stopOnError = true,
      onSuccess,
      onFailure,
    } = options;

    // Prevent multiple concurrent process() calls
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    this.lastError = null;
    this.abortController = new AbortController();

    try {
      // Crash recovery: mark any 'processing' entries as 'pending'
      await this.recoverStaleEntries();

      // Process loop
      while (!this.isPaused && !this.abortController.signal.aborted) {
        // Check if we're online
        const online = await this.onlineCheck();
        if (!online) {
          // Wait a bit and check again
          await delay(1000);
          continue;
        }

        // Get pending entries
        const entries = await this.storage.getAll();
        const pending = entries.filter(e => e.status === 'pending');

        if (pending.length === 0) {
          break;
        }

        // Process up to 'concurrency' entries in parallel
        const batch = pending.slice(0, concurrency);
        const results = await Promise.allSettled(
          batch.map(entry => this.processEntry(entry))
        );

        // Handle results
        let hasError = false;
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const entry = batch[i];
          
          if (!entry || !result) continue;

          if (result.status === 'fulfilled') {
            // Entry processed successfully
            await this.storage.remove(entry.id);
            onSuccess?.(entry);
          } else {
            // Entry failed
            hasError = true;
            const error = result.reason instanceof Error 
              ? result.reason 
              : new Error(String(result.reason));
            
            // Get updated entry from storage (it may have been updated)
            const updatedEntry = await this.storage.get(entry.id);
            if (updatedEntry) {
              onFailure?.(updatedEntry, error);
            }
            
            if (stopOnError) {
              this.lastError = error;
              break;
            }
          }
        }

        // Stop if we encountered an error and stopOnError is true
        if (hasError && stopOnError) {
          break;
        }
      }
    } finally {
      this.isProcessing = false;
      this.abortController = null;
    }
  }

  /**
   * Process a single entry.
   * 
   * @param entry The entry to process
   * @throws Error if processing fails
   */
  private async processEntry(entry: LedgerEntry): Promise<void> {
    // Mark as processing
    await this.storage.update(entry.id, {
      status: 'processing',
      lastAttemptAt: Date.now(),
      attemptCount: entry.attemptCount + 1,
    });

    // Fire replay start hook
    this.hooks.onReplayStart?.(entry);

    try {
      // Build the request
      const headers = new Headers(entry.request.headers);
      
      // Add idempotency key if present
      if (entry.idempotencyKey) {
        headers.set(this.idempotencyHeader, entry.idempotencyKey);
      }

      // Determine body
      let body: string | undefined;
      if (entry.request.body !== undefined && entry.request.body !== null) {
        body = JSON.stringify(entry.request.body);
        if (!headers.has('Content-Type')) {
          headers.set('Content-Type', 'application/json');
        }
      }

      // Make the request
      const response = await fetch(entry.request.url, {
        method: entry.request.method,
        headers,
        body,
        signal: this.abortController?.signal,
      });

      // Check for client errors (4xx) - not retryable
      if (isClientError(response.status)) {
        const error = new Error(`HTTP ${response.status}: Client error`);
        await this.markAsFailed(entry, error, response.status.toString());
        this.hooks.onReplayFailure?.(entry, error);
        throw error;
      }

      // Check for server errors (5xx) - retryable
      if (isRetryableStatusCode(response.status)) {
        const canRetryMore = this.canRetryEntry(entry);
        
        if (canRetryMore) {
          // Mark back as pending for retry
          await this.storage.update(entry.id, { status: 'pending' });
          
          // Wait for backoff delay
          const backoffDelay = calculateBackoffDelay(this.retry, entry.attemptCount + 1);
          if (backoffDelay !== null) {
            await delay(backoffDelay);
          }
          
          throw new Error(`HTTP ${response.status}: Server error, will retry`);
        } else {
          // No more retries, mark as failed
          const error = new Error(`HTTP ${response.status}: Server error, max retries exceeded`);
          await this.markAsFailed(entry, error, response.status.toString());
          this.hooks.onReplayFailure?.(entry, error);
          throw error;
        }
      }

      // Success! Fire success hook
      this.hooks.onReplaySuccess?.(entry, response);
      
    } catch (error: unknown) {
      // Check if it's a network error
      if (isNetworkError(error)) {
        const canRetryMore = this.canRetryEntry(entry);
        
        if (canRetryMore) {
          // Mark back as pending for retry
          await this.storage.update(entry.id, { status: 'pending' });
          
          // Wait for backoff delay
          const backoffDelay = calculateBackoffDelay(this.retry, entry.attemptCount + 1);
          if (backoffDelay !== null) {
            await delay(backoffDelay);
          }
        } else {
          // No more retries, mark as failed
          const networkError = new NetworkError(
            'Network error, max retries exceeded',
            error instanceof Error ? error : undefined
          );
          await this.markAsFailed(entry, networkError, 'NETWORK_ERROR');
          this.hooks.onReplayFailure?.(entry, networkError);
        }
        
        throw error;
      }
      
      // Re-throw other errors (they were already handled above)
      throw error;
    }
  }

  /**
   * Check if entry can be retried based on retry strategy.
   */
  private canRetryEntry(entry: LedgerEntry): boolean {
    if (this.retry.type === 'manual') {
      return false; // Manual retries don't auto-retry
    }
    return entry.attemptCount + 1 < this.retry.maxAttempts;
  }

  /**
   * Mark an entry as failed.
   */
  private async markAsFailed(
    entry: LedgerEntry,
    error: Error,
    code?: string
  ): Promise<void> {
    await this.storage.update(entry.id, {
      status: 'failed',
      error: {
        message: error.message,
        code,
      },
    });
  }

  /**
   * Recover stale 'processing' entries.
   * 
   * This handles crash recovery: if the page was closed while
   * processing, entries would be stuck in 'processing' state.
   */
  private async recoverStaleEntries(): Promise<void> {
    const entries = await this.storage.getAll();
    
    for (const entry of entries) {
      if (entry.status === 'processing') {
        await this.storage.update(entry.id, { status: 'pending' });
      }
    }
  }

  /**
   * Pause processing.
   */
  pause(): void {
    this.isPaused = true;
    this.abortController?.abort();
  }

  /**
   * Resume processing.
   */
  resume(): void {
    this.isPaused = false;
  }

  /**
   * Check if processing is paused.
   */
  get paused(): boolean {
    return this.isPaused;
  }

  /**
   * Check if currently processing.
   */
  get processing(): boolean {
    return this.isProcessing;
  }
}
