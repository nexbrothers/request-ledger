/**
 * Request Ledger - Type Definitions
 * 
 * This file contains all public TypeScript interfaces and types
 * for the request-ledger library.
 */

// =============================================================================
// HTTP Method Types
// =============================================================================

/**
 * Supported HTTP methods for ledger requests.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// =============================================================================
// Ledger Entry Types
// =============================================================================

/**
 * The status of a ledger entry.
 * 
 * - `pending`: Request is queued and waiting to be processed
 * - `processing`: Request is currently being executed
 * - `completed`: Request completed successfully (transient, removed after success)
 * - `failed`: Request failed after all retry attempts
 */
export type EntryStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Error information stored with a failed entry.
 */
export interface EntryError {
  /** Human-readable error message */
  message: string;
  /** Optional error code (e.g., HTTP status code or error type) */
  code?: string;
}

/**
 * The HTTP request data stored in a ledger entry.
 */
export interface StoredRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A single entry in the request ledger.
 * 
 * This schema is public and will not have hidden fields.
 * All fields are explicitly documented.
 */
export interface LedgerEntry {
  /** Unique identifier for this entry (provided by caller) */
  id: string;
  
  /** The HTTP request data */
  request: StoredRequest;
  
  /** Current status of this entry */
  status: EntryStatus;
  
  /** Number of times this request has been attempted */
  attemptCount: number;
  
  /** Timestamp when entry was created (ms since epoch) */
  createdAt: number;
  
  /** Timestamp of last attempt (ms since epoch) */
  lastAttemptAt?: number;
  
  /** Error information if status is 'failed' */
  error?: EntryError;
  
  /** Optional idempotency key for safe replay */
  idempotencyKey?: string;
  
  /** Optional user-provided metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Patch type for updating ledger entries.
 * Allows undefined values for optional fields to support clearing them.
 */
export type LedgerEntryPatch = {
  status?: EntryStatus;
  attemptCount?: number;
  lastAttemptAt?: number;
  error?: EntryError | undefined;
};

// =============================================================================
// Request Options
// =============================================================================

/**
 * Options for making a request through the ledger.
 */
export interface RequestOptions {
  /** Unique identifier for this request (required) */
  id: string;
  
  /** Target URL for the request */
  url: string;
  
  /** HTTP method */
  method: HttpMethod;
  
  /** Optional HTTP headers */
  headers?: Record<string, string>;
  
  /** Optional request body (will be JSON serialized) */
  body?: unknown;
  
  /** Optional idempotency key for safe replay */
  idempotencyKey?: string;
  
  /** Optional user-provided metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Process Options
// =============================================================================

/**
 * Options for processing the ledger queue.
 */
export interface ProcessOptions {
  /** 
   * Number of concurrent requests to process.
   * @default 1
   */
  concurrency?: number;
  
  /**
   * Whether to stop processing on first error.
   * @default true
   */
  stopOnError?: boolean;
  
  /** Callback invoked when an entry completes successfully */
  onSuccess?: (entry: LedgerEntry) => void;
  
  /** Callback invoked when an entry fails */
  onFailure?: (entry: LedgerEntry, error: Error) => void;
}

// =============================================================================
// Ledger State
// =============================================================================

/**
 * The current state of the ledger processor.
 * 
 * - `idle`: No pending entries, not processing
 * - `pending`: Has pending entries, not currently processing
 * - `processing`: Currently processing entries
 * - `paused`: Processing is paused by user
 * - `error`: Last processing run encountered an error
 */
export type LedgerState = 'idle' | 'pending' | 'processing' | 'paused' | 'error';

// =============================================================================
// Retry Strategy
// =============================================================================

/**
 * Fixed delay retry strategy.
 */
export interface FixedRetryStrategy {
  type: 'fixed';
  /** Delay between retries in milliseconds */
  delayMs: number;
  /** Maximum number of retry attempts */
  maxAttempts: number;
}

/**
 * Exponential backoff retry strategy.
 */
export interface ExponentialRetryStrategy {
  type: 'exponential';
  /** Base delay in milliseconds */
  baseMs: number;
  /** Maximum delay in milliseconds */
  maxMs: number;
  /** Maximum number of retry attempts */
  maxAttempts: number;
}

/**
 * Manual retry strategy - user controls when to retry.
 */
export interface ManualRetryStrategy {
  type: 'manual';
}

/**
 * Retry strategy configuration.
 */
export type RetryStrategy = FixedRetryStrategy | ExponentialRetryStrategy | ManualRetryStrategy;

// =============================================================================
// Lifecycle Hooks
// =============================================================================

/**
 * Lifecycle hooks for observability.
 */
export interface LedgerHooks {
  /** Called when a request is persisted to the ledger */
  onPersist?: (entry: LedgerEntry) => void;
  
  /** Called when replay starts for an entry */
  onReplayStart?: (entry: LedgerEntry) => void;
  
  /** Called when replay succeeds for an entry */
  onReplaySuccess?: (entry: LedgerEntry, response: Response) => void;
  
  /** Called when replay fails for an entry */
  onReplayFailure?: (entry: LedgerEntry, error: Error) => void;
}

// =============================================================================
// Online Check
// =============================================================================

/**
 * Custom online check function.
 * Should return true if online, false if offline.
 */
export type OnlineCheckFn = () => Promise<boolean>;

/**
 * Configuration for online detection.
 */
export interface OnlineCheckConfig {
  /**
   * URL to ping for online detection.
   * If not provided, only navigator.onLine is used.
   */
  pingUrl?: string;
  
  /**
   * Timeout for ping requests in milliseconds.
   * @default 5000
   */
  pingTimeout?: number;
  
  /**
   * Custom online check function.
   * If provided, overrides default behavior.
   */
  customCheck?: OnlineCheckFn;
}

// =============================================================================
// Storage Configuration
// =============================================================================

/**
 * Configuration for IndexedDB storage.
 */
export interface IndexedDBStorageConfig {
  /**
   * Name of the IndexedDB database.
   * @default "request-ledger"
   */
  dbName?: string;
  
  /**
   * Name of the object store.
   * @default "entries"
   */
  storeName?: string;
  
  /**
   * Maximum number of entries to store.
   * When exceeded, oldest entries are evicted.
   * @default 1000
   */
  maxEntries?: number;
}

// =============================================================================
// Ledger Configuration
// =============================================================================

/**
 * Configuration options for creating a ledger instance.
 */
export interface LedgerConfig {
  /**
   * Custom storage adapter.
   * If not provided, IndexedDB storage is used.
   */
  storage?: LedgerStorage;
  
  /**
   * Configuration for IndexedDB storage (ignored if custom storage provided).
   */
  storageConfig?: IndexedDBStorageConfig;
  
  /**
   * Retry strategy configuration.
   * @default { type: 'exponential', baseMs: 1000, maxMs: 30000, maxAttempts: 3 }
   */
  retry?: RetryStrategy;
  
  /**
   * Online detection configuration.
   */
  onlineCheck?: OnlineCheckConfig;
  
  /**
   * Lifecycle hooks for observability.
   */
  hooks?: LedgerHooks;
  
  /**
   * Header name for idempotency key.
   * @default "X-Idempotency-Key"
   */
  idempotencyHeader?: string;
}

// =============================================================================
// Storage Interface
// =============================================================================

/**
 * Pluggable storage interface for the ledger.
 * 
 * Implementations must ensure:
 * - Writes are atomic
 * - Entries survive page reloads
 * - Proper error handling
 */
export interface LedgerStorage {
  /**
   * Store a new entry.
   * Should throw if entry with same ID already exists.
   */
  put(entry: LedgerEntry): Promise<void>;
  
  /**
   * Get all entries, ordered by createdAt ascending.
   */
  getAll(): Promise<LedgerEntry[]>;
  
  /**
   * Get a single entry by ID.
   */
  get(id: string): Promise<LedgerEntry | undefined>;
  
  /**
   * Update an existing entry.
   * Should throw if entry does not exist.
   */
  update(id: string, patch: LedgerEntryPatch): Promise<void>;
  
  /**
   * Remove an entry by ID.
   */
  remove(id: string): Promise<void>;
  
  /**
   * Remove all entries.
   */
  clear(): Promise<void>;
  
  /**
   * Get the count of entries.
   */
  count(): Promise<number>;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Base error class for request-ledger errors.
 */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Error thrown when persistence fails.
 */
export class PersistenceError extends LedgerError {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'PersistenceError';
  }
}

/**
 * Error thrown when a network request fails.
 */
export class NetworkError extends LedgerError {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Error thrown when an entry is not found.
 */
export class EntryNotFoundError extends LedgerError {
  constructor(public readonly entryId: string) {
    super(`Entry not found: ${entryId}`);
    this.name = 'EntryNotFoundError';
  }
}

/**
 * Error thrown when a duplicate entry is detected.
 */
export class DuplicateEntryError extends LedgerError {
  constructor(public readonly entryId: string) {
    super(`Duplicate entry: ${entryId}`);
    this.name = 'DuplicateEntryError';
  }
}
