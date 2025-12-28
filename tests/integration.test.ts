/**
 * Integration Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLedger, IndexedDBStorage } from '../src/index.js';
import type { LedgerEntry, LedgerHooks } from '../src/types.js';

describe('RequestLedger Integration', () => {
  let storage: IndexedDBStorage;
  let testId: number = 0;
  
  beforeEach(async () => {
    testId++;
    storage = new IndexedDBStorage({
      dbName: `integration-test-${Date.now()}-${testId}-${Math.random().toString(36).slice(2)}`,
      maxEntries: 100,
    });
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await storage.clear();
    storage.close();
  });

  describe('request', () => {
    it('should queue request when offline', async () => {
      const onPersist = vi.fn();
      
      const ledger = createLedger({
        storage,
        onlineCheck: { customCheck: async () => false },
        hooks: { onPersist },
      });

      await ledger.request({
        id: 'test-1',
        url: 'https://api.example.com/test',
        method: 'POST',
        body: { data: 'test' },
      });

      const entries = await ledger.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.id).toBe('test-1');
      expect(entries[0]?.status).toBe('pending');
      expect(onPersist).toHaveBeenCalled();
      
      await ledger.destroy();
    });

    it('should attempt immediately when online and succeed', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });
      
      const ledger = createLedger({
        storage,
        onlineCheck: { customCheck: async () => true },
      });

      const response = await ledger.request({
        id: 'test-1',
        url: 'https://api.example.com/test',
        method: 'GET',
      });

      expect(response).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
      
      // Should not be queued
      const entries = await ledger.list();
      expect(entries).toHaveLength(0);
      
      await ledger.destroy();
    });

    it('should queue when online but network fails', async () => {
      global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      
      const ledger = createLedger({
        storage,
        onlineCheck: { customCheck: async () => true },
      });

      await ledger.request({
        id: 'test-1',
        url: 'https://api.example.com/test',
        method: 'POST',
      });

      const entries = await ledger.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.status).toBe('pending');
      
      await ledger.destroy();
    });
  });

  describe('state management', () => {
    it('should report idle when no entries', async () => {
      const ledger = createLedger({ storage });
      expect(await ledger.getState()).toBe('idle');
      await ledger.destroy();
    });

    it('should report pending when entries exist', async () => {
      const ledger = createLedger({
        storage,
        onlineCheck: { customCheck: async () => false },
      });

      await ledger.request({
        id: 'test-1',
        url: 'https://api.example.com/test',
        method: 'POST',
      });

      expect(await ledger.getState()).toBe('pending');
      await ledger.destroy();
    });

    it('should report paused after pause()', async () => {
      const ledger = createLedger({
        storage,
        onlineCheck: { customCheck: async () => false },
      });

      await ledger.request({
        id: 'test-1',
        url: 'https://api.example.com/test',
        method: 'POST',
      });

      ledger.pause();
      expect(await ledger.getState()).toBe('paused');
      
      ledger.resume();
      expect(await ledger.getState()).toBe('pending');
      
      await ledger.destroy();
    });
  });

  describe('manual retry', () => {
    it('should reset failed entry to pending', async () => {
      const ledger = createLedger({
        storage,
        onlineCheck: { customCheck: async () => false },
      });

      // Add an entry
      await ledger.request({
        id: 'test-1',
        url: 'https://api.example.com/test',
        method: 'POST',
      });

      // Manually mark as failed (simulating failed processing)
      await storage.update('test-1', {
        status: 'failed',
        error: { message: 'Test failure' },
      });

      // Retry
      await ledger.retry('test-1');

      const entry = await ledger.get('test-1');
      expect(entry?.status).toBe('pending');
      expect(entry?.error).toBeUndefined();
      
      await ledger.destroy();
    });

    it('should throw for non-existent entry', async () => {
      const ledger = createLedger({ storage });
      
      await expect(ledger.retry('non-existent')).rejects.toThrow('Entry not found');
      
      await ledger.destroy();
    });
  });

  describe('clear and remove', () => {
    it('should remove specific entry', async () => {
      const ledger = createLedger({
        storage,
        onlineCheck: { customCheck: async () => false },
      });

      await ledger.request({ id: 'test-1', url: '/test', method: 'POST' });
      await ledger.request({ id: 'test-2', url: '/test', method: 'POST' });

      await ledger.remove('test-1');

      const entries = await ledger.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.id).toBe('test-2');
      
      await ledger.destroy();
    });

    it('should clear all entries', async () => {
      const ledger = createLedger({
        storage,
        onlineCheck: { customCheck: async () => false },
      });

      await ledger.request({ id: 'test-1', url: '/test', method: 'POST' });
      await ledger.request({ id: 'test-2', url: '/test', method: 'POST' });

      await ledger.clear();

      const entries = await ledger.list();
      expect(entries).toHaveLength(0);
      
      await ledger.destroy();
    });
  });

  describe('idempotency key', () => {
    it('should include idempotency key in stored entry', async () => {
      const ledger = createLedger({
        storage,
        onlineCheck: { customCheck: async () => false },
      });

      await ledger.request({
        id: 'test-1',
        url: 'https://api.example.com/test',
        method: 'POST',
        idempotencyKey: 'idem-key-123',
      });

      const entry = await ledger.get('test-1');
      expect(entry?.idempotencyKey).toBe('idem-key-123');
      
      await ledger.destroy();
    });
  });

  describe('destroy', () => {
    it('should prevent further operations after destroy', async () => {
      const ledger = createLedger({ storage });
      await ledger.destroy();

      await expect(ledger.list()).rejects.toThrow('Ledger has been destroyed');
      await expect(ledger.request({ id: 'x', url: '/', method: 'GET' })).rejects.toThrow();
    });
  });
});
