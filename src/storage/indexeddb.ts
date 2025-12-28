/**
 * IndexedDB Storage Adapter
 * 
 * Implements the LedgerStorage interface using IndexedDB for
 * persistent, reliable storage that survives page reloads.
 */

import type { LedgerEntry, LedgerStorage, IndexedDBStorageConfig, LedgerEntryPatch } from '../types.js';
import { PersistenceError, EntryNotFoundError, DuplicateEntryError } from '../types.js';

const DEFAULT_DB_NAME = 'request-ledger';
const DEFAULT_STORE_NAME = 'entries';
const DEFAULT_MAX_ENTRIES = 1000;
const DB_VERSION = 1;

/**
 * IndexedDB implementation of LedgerStorage.
 * 
 * Features:
 * - Atomic writes using transactions
 * - Entries ordered by createdAt
 * - Max size enforcement with oldest-first eviction
 * - Proper error handling
 */
export class IndexedDBStorage implements LedgerStorage {
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly maxEntries: number;
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(config: IndexedDBStorageConfig = {}) {
    this.dbName = config.dbName ?? DEFAULT_DB_NAME;
    this.storeName = config.storeName ?? DEFAULT_STORE_NAME;
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Get or initialize the database connection.
   */
  private async getDb(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => {
        reject(new PersistenceError('Failed to open IndexedDB', request.error ?? undefined));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
          
          // Create indexes for efficient querying
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('idempotencyKey', 'idempotencyKey', { unique: false });
        }
      };
    });

    return this.dbPromise;
  }

  /**
   * Execute a transaction and return a promise.
   */
  private async transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await this.getDb();
    
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode);
      const store = tx.objectStore(this.storeName);
      
      const request = operation(store);
      
      request.onsuccess = () => {
        resolve(request.result);
      };
      
      request.onerror = () => {
        reject(new PersistenceError('Transaction failed', request.error ?? undefined));
      };
      
      tx.onerror = () => {
        reject(new PersistenceError('Transaction failed', tx.error ?? undefined));
      };
    });
  }

  /**
   * Store a new entry.
   * Throws DuplicateEntryError if entry with same ID exists.
   * Evicts oldest entries if maxEntries is exceeded.
   */
  async put(entry: LedgerEntry): Promise<void> {
    const db = await this.getDb();
    
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      
      // First check if entry already exists
      const getRequest = store.get(entry.id);
      
      getRequest.onsuccess = () => {
        if (getRequest.result) {
          reject(new DuplicateEntryError(entry.id));
          return;
        }
        
        // Serialize body and metadata for storage
        const storedEntry = {
          ...entry,
          request: {
            ...entry.request,
            body: JSON.stringify(entry.request.body),
          },
          metadata: entry.metadata ? JSON.stringify(entry.metadata) : undefined,
        };
        
        const addRequest = store.add(storedEntry);
        
        addRequest.onsuccess = () => {
          // Check if we need to evict old entries
          this.evictIfNeeded(store).then(resolve).catch(reject);
        };
        
        addRequest.onerror = () => {
          reject(new PersistenceError('Failed to add entry', addRequest.error ?? undefined));
        };
      };
      
      getRequest.onerror = () => {
        reject(new PersistenceError('Failed to check for existing entry', getRequest.error ?? undefined));
      };
      
      tx.onerror = () => {
        reject(new PersistenceError('Transaction failed', tx.error ?? undefined));
      };
    });
  }

  /**
   * Evict oldest entries if count exceeds maxEntries.
   */
  private async evictIfNeeded(store: IDBObjectStore): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const countRequest = store.count();
      
      countRequest.onsuccess = () => {
        const count = countRequest.result;
        
        if (count <= this.maxEntries) {
          resolve();
          return;
        }
        
        const toDelete = count - this.maxEntries;
        const index = store.index('createdAt');
        const cursorRequest = index.openCursor();
        let deleted = 0;
        
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          
          if (cursor && deleted < toDelete) {
            store.delete(cursor.primaryKey);
            deleted++;
            cursor.continue();
          } else {
            resolve();
          }
        };
        
        cursorRequest.onerror = () => {
          reject(new PersistenceError('Failed to evict entries', cursorRequest.error ?? undefined));
        };
      };
      
      countRequest.onerror = () => {
        reject(new PersistenceError('Failed to count entries', countRequest.error ?? undefined));
      };
    });
  }

  /**
   * Get all entries ordered by createdAt ascending.
   */
  async getAll(): Promise<LedgerEntry[]> {
    const db = await this.getDb();
    
    return new Promise<LedgerEntry[]>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const index = store.index('createdAt');
      const request = index.getAll();
      
      request.onsuccess = () => {
        const entries = request.result.map(this.deserializeEntry);
        resolve(entries);
      };
      
      request.onerror = () => {
        reject(new PersistenceError('Failed to get entries', request.error ?? undefined));
      };
    });
  }

  /**
   * Get a single entry by ID.
   */
  async get(id: string): Promise<LedgerEntry | undefined> {
    const result = await this.transaction('readonly', (store) => store.get(id));
    return result ? this.deserializeEntry(result) : undefined;
  }

  /**
   * Update an existing entry.
   */
  async update(id: string, patch: LedgerEntryPatch): Promise<void> {
    const db = await this.getDb();
    
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const getRequest = store.get(id);
      
      getRequest.onsuccess = () => {
        const existing = getRequest.result;
        
        if (!existing) {
          reject(new EntryNotFoundError(id));
          return;
        }
        
        // Merge patch with existing entry
        const updated = { ...existing };
        
        if (patch.status !== undefined) updated.status = patch.status;
        if (patch.attemptCount !== undefined) updated.attemptCount = patch.attemptCount;
        if (patch.lastAttemptAt !== undefined) updated.lastAttemptAt = patch.lastAttemptAt;
        // Allow explicitly clearing error by checking if key exists in patch
        if ('error' in patch) {
          if (patch.error === undefined) {
            delete updated.error;
          } else {
            updated.error = patch.error;
          }
        }
        
        const putRequest = store.put(updated);
        
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => {
          reject(new PersistenceError('Failed to update entry', putRequest.error ?? undefined));
        };
      };
      
      getRequest.onerror = () => {
        reject(new PersistenceError('Failed to get entry for update', getRequest.error ?? undefined));
      };
      
      tx.onerror = () => {
        reject(new PersistenceError('Transaction failed', tx.error ?? undefined));
      };
    });
  }

  /**
   * Remove an entry by ID.
   */
  async remove(id: string): Promise<void> {
    await this.transaction('readwrite', (store) => store.delete(id));
  }

  /**
   * Remove all entries.
   */
  async clear(): Promise<void> {
    await this.transaction('readwrite', (store) => store.clear());
  }

  /**
   * Get the count of entries.
   */
  async count(): Promise<number> {
    return this.transaction('readonly', (store) => store.count());
  }

  /**
   * Deserialize an entry from storage.
   */
  private deserializeEntry(stored: Record<string, unknown>): LedgerEntry {
    const request = stored['request'] as Record<string, unknown>;
    
    return {
      id: stored['id'] as string,
      request: {
        url: request['url'] as string,
        method: request['method'] as LedgerEntry['request']['method'],
        headers: request['headers'] as Record<string, string>,
        body: request['body'] ? JSON.parse(request['body'] as string) : undefined,
      },
      status: stored['status'] as LedgerEntry['status'],
      attemptCount: stored['attemptCount'] as number,
      createdAt: stored['createdAt'] as number,
      lastAttemptAt: stored['lastAttemptAt'] as number | undefined,
      error: stored['error'] as LedgerEntry['error'],
      idempotencyKey: stored['idempotencyKey'] as string | undefined,
      metadata: stored['metadata'] 
        ? JSON.parse(stored['metadata'] as string) 
        : undefined,
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPromise = null;
    }
  }
}
