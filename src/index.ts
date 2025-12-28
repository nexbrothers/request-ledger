/**
 * Request Ledger
 * 
 * A durable, client-side HTTP request ledger for web applications
 * operating on unreliable networks.
 * 
 * @packageDocumentation
 */

// Core ledger
export { RequestLedger, createLedger } from './ledger.js';

// Types
export type {
  // Entry types
  LedgerEntry,
  LedgerEntryPatch,
  EntryStatus,
  EntryError,
  StoredRequest,
  
  // Request/Process options
  RequestOptions,
  ProcessOptions,
  HttpMethod,
  
  // State
  LedgerState,
  
  // Retry
  RetryStrategy,
  FixedRetryStrategy,
  ExponentialRetryStrategy,
  ManualRetryStrategy,
  
  // Configuration
  LedgerConfig,
  LedgerHooks,
  OnlineCheckConfig,
  OnlineCheckFn,
  IndexedDBStorageConfig,
  
  // Storage
  LedgerStorage,
} from './types.js';

// Errors
export {
  LedgerError,
  PersistenceError,
  NetworkError,
  EntryNotFoundError,
  DuplicateEntryError,
} from './types.js';

// Storage adapters
export { IndexedDBStorage } from './storage/indexeddb.js';

// Online detection
export { createOnlineChecker, isNetworkError, isRetryableStatusCode } from './online/checker.js';

// Utilities
export { calculateBackoffDelay, canRetry, delay } from './utils/backoff.js';
