/**
 * Storage Layer Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexedDBStorage } from '../src/storage/indexeddb.js';
import type { LedgerEntry } from '../src/types.js';
import { DuplicateEntryError, EntryNotFoundError } from '../src/types.js';

function createEntry(id: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id,
    request: {
      url: 'https://api.example.com/test',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { test: 'data' },
    },
    status: 'pending',
    attemptCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('IndexedDBStorage', () => {
  let storage: IndexedDBStorage;

  beforeEach(() => {
    storage = new IndexedDBStorage({
      dbName: `test-db-${Date.now()}`,
      maxEntries: 10,
    });
  });

  afterEach(() => {
    storage.close();
  });

  describe('put', () => {
    it('should store a new entry', async () => {
      const entry = createEntry('test-1');
      await storage.put(entry);
      
      const retrieved = await storage.get('test-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('test-1');
      expect(retrieved?.request.url).toBe('https://api.example.com/test');
    });

    it('should throw DuplicateEntryError for duplicate ID', async () => {
      const entry = createEntry('test-1');
      await storage.put(entry);
      
      await expect(storage.put(entry)).rejects.toThrow(DuplicateEntryError);
    });

    it('should serialize and deserialize body correctly', async () => {
      const entry = createEntry('test-1', {
        request: {
          url: 'https://api.example.com/test',
          method: 'POST',
          headers: {},
          body: { nested: { data: [1, 2, 3] } },
        },
      });
      await storage.put(entry);
      
      const retrieved = await storage.get('test-1');
      expect(retrieved?.request.body).toEqual({ nested: { data: [1, 2, 3] } });
    });

    it('should serialize and deserialize metadata correctly', async () => {
      const entry = createEntry('test-1', {
        metadata: { userId: 123, action: 'create' },
      });
      await storage.put(entry);
      
      const retrieved = await storage.get('test-1');
      expect(retrieved?.metadata).toEqual({ userId: 123, action: 'create' });
    });
  });

  describe('getAll', () => {
    it('should return entries ordered by createdAt', async () => {
      const entry1 = createEntry('test-1', { createdAt: 1000 });
      const entry2 = createEntry('test-2', { createdAt: 3000 });
      const entry3 = createEntry('test-3', { createdAt: 2000 });
      
      await storage.put(entry1);
      await storage.put(entry2);
      await storage.put(entry3);
      
      const all = await storage.getAll();
      expect(all).toHaveLength(3);
      expect(all[0]?.id).toBe('test-1');
      expect(all[1]?.id).toBe('test-3');
      expect(all[2]?.id).toBe('test-2');
    });

    it('should return empty array when no entries exist', async () => {
      const all = await storage.getAll();
      expect(all).toEqual([]);
    });
  });

  describe('update', () => {
    it('should update an existing entry', async () => {
      const entry = createEntry('test-1');
      await storage.put(entry);
      
      await storage.update('test-1', {
        status: 'processing',
        attemptCount: 1,
        lastAttemptAt: 12345,
      });
      
      const retrieved = await storage.get('test-1');
      expect(retrieved?.status).toBe('processing');
      expect(retrieved?.attemptCount).toBe(1);
      expect(retrieved?.lastAttemptAt).toBe(12345);
    });

    it('should throw EntryNotFoundError for non-existent entry', async () => {
      await expect(
        storage.update('non-existent', { status: 'failed' })
      ).rejects.toThrow(EntryNotFoundError);
    });
  });

  describe('remove', () => {
    it('should remove an entry', async () => {
      const entry = createEntry('test-1');
      await storage.put(entry);
      
      await storage.remove('test-1');
      
      const retrieved = await storage.get('test-1');
      expect(retrieved).toBeUndefined();
    });

    it('should not throw for non-existent entry', async () => {
      await expect(storage.remove('non-existent')).resolves.toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all entries', async () => {
      await storage.put(createEntry('test-1'));
      await storage.put(createEntry('test-2'));
      await storage.put(createEntry('test-3'));
      
      await storage.clear();
      
      const all = await storage.getAll();
      expect(all).toEqual([]);
    });
  });

  describe('count', () => {
    it('should return correct count', async () => {
      expect(await storage.count()).toBe(0);
      
      await storage.put(createEntry('test-1'));
      expect(await storage.count()).toBe(1);
      
      await storage.put(createEntry('test-2'));
      expect(await storage.count()).toBe(2);
      
      await storage.remove('test-1');
      expect(await storage.count()).toBe(1);
    });
  });

  describe('eviction', () => {
    it('should evict oldest entries when maxEntries exceeded', async () => {
      // Create storage with max 3 entries
      const smallStorage = new IndexedDBStorage({
        dbName: `eviction-test-${Date.now()}`,
        maxEntries: 3,
      });

      try {
        await smallStorage.put(createEntry('test-1', { createdAt: 1000 }));
        await smallStorage.put(createEntry('test-2', { createdAt: 2000 }));
        await smallStorage.put(createEntry('test-3', { createdAt: 3000 }));
        
        // This should evict test-1 (oldest)
        await smallStorage.put(createEntry('test-4', { createdAt: 4000 }));
        
        const all = await smallStorage.getAll();
        expect(all).toHaveLength(3);
        expect(all.map(e => e.id)).toEqual(['test-2', 'test-3', 'test-4']);
      } finally {
        smallStorage.close();
      }
    });
  });
});
