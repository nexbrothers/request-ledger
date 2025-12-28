/**
 * Request Ledger
 * 
 * A durable, client-side HTTP request ledger for web applications
 * operating on unreliable networks.
 * 
 * Core behaviors:
 * - Records API request intent when offline or network is unstable
 * - Persists requests across page reloads, crashes, and browser restarts
 * - Replays requests deterministically when connectivity is restored
 * - Never silently drops requests
 * - Never assumes business-level conflict resolution
 */

import type {
  LedgerConfig,
  LedgerEntry,
  LedgerState,
  LedgerStorage,
  ProcessOptions,
  RequestOptions,
  RetryStrategy,
  LedgerHooks,
  OnlineCheckFn,
} from './types.js';
import { PersistenceError } from './types.js';
import { IndexedDBStorage } from './storage/indexeddb.js';
import { createOnlineChecker, isNetworkError } from './online/checker.js';
import { ReplayEngine } from './replay/engine.js';
import { DEFAULT_RETRY_STRATEGY } from './utils/backoff.js';

const DEFAULT_IDEMPOTENCY_HEADER = 'X-Idempotency-Key';

/**
 * The main RequestLedger class.
 * 
 * Provides a durable request queue that persists across page reloads
 * and replays requests when connectivity is restored.
 */
export class RequestLedger {
  private readonly storage: LedgerStorage;
  private readonly onlineCheck: OnlineCheckFn;
  private readonly retryStrategy: RetryStrategy;
  private readonly hooks: LedgerHooks;
  private readonly idempotencyHeader: string;
  private readonly replayEngine: ReplayEngine;
  private readonly autoProcess: boolean;
  private readonly autoProcessOptions: ProcessOptions;
  private isDestroyed = false;
  private onlineHandler: (() => void) | null = null;

  constructor(config: LedgerConfig = {}) {
    // Initialize storage
    this.storage = config.storage ?? new IndexedDBStorage(config.storageConfig);
    
    // Initialize online checker
    this.onlineCheck = createOnlineChecker(config.onlineCheck);
    
    // Set retry strategy
    this.retryStrategy = config.retry ?? DEFAULT_RETRY_STRATEGY;
    
    // Set hooks
    this.hooks = config.hooks ?? {};
    
    // Set idempotency header
    this.idempotencyHeader = config.idempotencyHeader ?? DEFAULT_IDEMPOTENCY_HEADER;
    
    // Set auto-process options
    this.autoProcess = config.autoProcess ?? false;
    this.autoProcessOptions = config.autoProcessOptions ?? {};
    
    // Initialize replay engine
    this.replayEngine = new ReplayEngine({
      storage: this.storage,
      onlineCheck: this.onlineCheck,
      retry: this.retryStrategy,
      hooks: this.hooks,
      idempotencyHeader: this.idempotencyHeader,
    });
    
    // Set up auto-processing if enabled
    if (this.autoProcess && typeof window !== 'undefined') {
      this.setupAutoProcess();
    }
  }

  /**
   * Set up automatic processing when coming back online.
   */
  private setupAutoProcess(): void {
    this.onlineHandler = () => {
      if (!this.isDestroyed) {
        // Use setTimeout to avoid blocking the event
        setTimeout(() => {
          this.process(this.autoProcessOptions).catch((error) => {
            console.error('[request-ledger] Auto-process error:', error);
          });
        }, 100);
      }
    };
    
    window.addEventListener('online', this.onlineHandler);
  }

  /**
   * Make a request through the ledger.
   * 
   * Behavior:
   * - If online → attempt immediately
   * - If offline or request fails due to network → persist to ledger
   * - If persistence fails → throw explicitly
   * 
   * @param options The request options
   * @returns Response if request succeeded immediately, void if queued
   */
  async request(options: RequestOptions): Promise<Response | void> {
    this.ensureNotDestroyed();

    // Check if online
    const online = await this.onlineCheck();

    if (online) {
      // Try to make the request immediately
      try {
        const response = await this.executeRequest(options);
        return response;
      } catch (error: unknown) {
        // If it's a network error, queue the request
        if (isNetworkError(error)) {
          await this.persistRequest(options);
          return;
        }
        // Re-throw non-network errors
        throw error;
      }
    } else {
      // Offline: queue the request
      await this.persistRequest(options);
    }
  }

  /**
   * Execute an HTTP request.
   */
  private async executeRequest(options: RequestOptions): Promise<Response> {
    const { url, method, headers = {}, body, idempotencyKey } = options;

    const requestHeaders = new Headers(headers);
    
    // Add idempotency key if present
    if (idempotencyKey) {
      requestHeaders.set(this.idempotencyHeader, idempotencyKey);
    }

    // Determine body
    let requestBody: string | undefined;
    if (body !== undefined && body !== null) {
      requestBody = JSON.stringify(body);
      if (!requestHeaders.has('Content-Type')) {
        requestHeaders.set('Content-Type', 'application/json');
      }
    }

    return fetch(url, {
      method,
      headers: requestHeaders,
      body: requestBody ?? null,
    });
  }

  /**
   * Persist a request to the ledger.
   */
  private async persistRequest(options: RequestOptions): Promise<void> {
    const entry: LedgerEntry = {
      id: options.id,
      request: {
        url: options.url,
        method: options.method,
        headers: options.headers ?? {},
        body: options.body,
      },
      status: 'pending',
      attemptCount: 0,
      createdAt: Date.now(),
      ...(options.idempotencyKey && { idempotencyKey: options.idempotencyKey }),
      ...(options.metadata && { metadata: options.metadata }),
    };

    try {
      await this.storage.put(entry);
      
      // Fire onPersist hook
      this.hooks.onPersist?.(entry);
    } catch (error: unknown) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      throw new PersistenceError(
        'Failed to persist request to ledger',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Process pending entries in the ledger.
   * 
   * @param options Processing options
   */
  async process(options: ProcessOptions = {}): Promise<void> {
    this.ensureNotDestroyed();
    await this.replayEngine.process(options);
  }

  /**
   * Pause processing.
   */
  pause(): void {
    this.ensureNotDestroyed();
    this.replayEngine.pause();
  }

  /**
   * Resume processing.
   */
  resume(): void {
    this.ensureNotDestroyed();
    this.replayEngine.resume();
  }

  /**
   * Clear all completed entries.
   * 
   * Note: In this implementation, completed entries are automatically
   * removed, so this is a no-op. Provided for API completeness.
   */
  async clearCompleted(): Promise<void> {
    this.ensureNotDestroyed();
    
    const entries = await this.storage.getAll();
    for (const entry of entries) {
      if (entry.status === 'completed') {
        await this.storage.remove(entry.id);
      }
    }
  }

  /**
   * Get the current state of the ledger.
   */
  async getState(): Promise<LedgerState> {
    this.ensureNotDestroyed();
    return this.replayEngine.getState();
  }

  /**
   * List all entries in the ledger.
   */
  async list(): Promise<LedgerEntry[]> {
    this.ensureNotDestroyed();
    return this.storage.getAll();
  }

  /**
   * Get a single entry by ID.
   */
  async get(id: string): Promise<LedgerEntry | undefined> {
    this.ensureNotDestroyed();
    return this.storage.get(id);
  }

  /**
   * Manually retry a failed entry.
   * 
   * This is useful when using the 'manual' retry strategy.
   * 
   * @param id The entry ID to retry
   */
  async retry(id: string): Promise<void> {
    this.ensureNotDestroyed();
    
    const entry = await this.storage.get(id);
    if (!entry) {
      throw new Error(`Entry not found: ${id}`);
    }
    
    if (entry.status !== 'failed') {
      throw new Error(`Entry is not in failed state: ${id}`);
    }
    
    // Reset status to pending and clear error
    await this.storage.update(id, {
      status: 'pending',
      error: undefined,
    });
  }

  /**
   * Remove a specific entry from the ledger.
   * 
   * @param id The entry ID to remove
   */
  async remove(id: string): Promise<void> {
    this.ensureNotDestroyed();
    await this.storage.remove(id);
  }

  /**
   * Clear all entries from the ledger.
   */
  async clear(): Promise<void> {
    this.ensureNotDestroyed();
    await this.storage.clear();
  }

  /**
   * Destroy the ledger instance.
   * 
   * This closes the storage connection and prevents further operations.
   */
  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    
    this.isDestroyed = true;
    this.replayEngine.pause();
    
    // Remove online event listener
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
    
    // Close storage if it has a close method
    if ('close' in this.storage && typeof this.storage.close === 'function') {
      (this.storage as { close: () => void }).close();
    }
  }

  /**
   * Ensure the ledger is not destroyed.
   */
  private ensureNotDestroyed(): void {
    if (this.isDestroyed) {
      throw new Error('Ledger has been destroyed');
    }
  }
}

/**
 * Create a new RequestLedger instance.
 * 
 * @param config Configuration options
 * @returns A new RequestLedger instance
 */
export function createLedger(config: LedgerConfig = {}): RequestLedger {
  return new RequestLedger(config);
}
