# request-ledger

A durable, client-side HTTP request ledger for web applications operating on unreliable networks.

[![npm version](https://img.shields.io/npm/v/request-ledger.svg)](https://www.npmjs.com/package/request-ledger)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Mental Model

Think of `request-ledger` as a **transactional outbox** for your client-side HTTP requests:

1. When your app needs to make an API request, it goes through the ledger
2. If online, the request executes immediately
3. If offline (or network fails), the request is **durably persisted** to IndexedDB
4. When connectivity returns, queued requests are **replayed in order**
5. Failed requests are never silently dropped

This is **not** a retry library (it doesn't retry on every failure), and **not** a sync engine (it doesn't resolve conflicts).

## Installation

```bash
npm install request-ledger
```

## Quick Start

```ts
import { createLedger } from "request-ledger";

const ledger = createLedger({
  onlineCheck: {
    pingUrl: "/api/health", // Optional: ping endpoint for reliable online detection
  },
  hooks: {
    onPersist: (entry) => console.log("Queued:", entry.id),
    onReplaySuccess: (entry) => console.log("Completed:", entry.id),
    onReplayFailure: (entry, error) =>
      console.error("Failed:", entry.id, error),
  },
});

// Make a request (queued if offline)
await ledger.request({
  id: "order-123", // Required: unique ID
  url: "/api/orders",
  method: "POST",
  body: { items: ["item-1", "item-2"] },
  idempotencyKey: "order-123-v1", // Recommended for safe replay
});

// Process queued requests when online
await ledger.process({ concurrency: 1, stopOnError: true });

// Check state
const state = await ledger.getState(); // 'idle' | 'pending' | 'processing' | 'paused' | 'error'
const entries = await ledger.list(); // All entries with status
```

## API Reference

### `createLedger(config?)`

Creates a new ledger instance.

```ts
const ledger = createLedger({
  // Optional: custom storage adapter (default: IndexedDB)
  storage: new IndexedDBStorage({ maxEntries: 1000 }),

  // Optional: retry strategy (default: exponential backoff)
  retry: { type: "exponential", baseMs: 1000, maxMs: 30000, maxAttempts: 3 },

  // Optional: online detection
  onlineCheck: {
    pingUrl: "/api/health",
    pingTimeout: 5000,
    customCheck: async () => {
      /* your logic */ return true;
    },
  },

  // Optional: lifecycle hooks
  hooks: {
    onPersist: (entry) => {},
    onReplayStart: (entry) => {},
    onReplaySuccess: (entry, response) => {},
    onReplayFailure: (entry, error) => {},
  },

  // Optional: idempotency header name (default: 'X-Idempotency-Key')
  idempotencyHeader: "X-Idempotency-Key",

  // Optional: auto-process when coming back online (default: false)
  autoProcess: true,

  // Optional: options used for auto-processing
  autoProcessOptions: {
    concurrency: 1,
    stopOnError: false,
  },
});
```

### `ledger.request(options)`

Make a request through the ledger.

```ts
await ledger.request({
  id: string;                     // Required: unique identifier
  url: string;                    // Required: target URL
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;                 // JSON serializable
  idempotencyKey?: string;        // For safe replay
  metadata?: Record<string, unknown>;  // Your custom data
});
```

**Behavior:**

- If online → attempts immediately, returns `Response`
- If offline or network fails → persists to ledger, returns `void`
- If persistence fails → throws `PersistenceError`

### `ledger.process(options?)`

Process queued entries.

```ts
await ledger.process({
  concurrency: 1, // Max concurrent requests (default: 1)
  stopOnError: true, // Stop on first failure (default: true)
  onSuccess: (entry) => {},
  onFailure: (entry, error) => {},
});
```

### Control Methods

```ts
ledger.pause(); // Pause processing
ledger.resume(); // Resume processing
await ledger.getState(); // 'idle' | 'pending' | 'processing' | 'paused' | 'error'
await ledger.list(); // All entries
await ledger.get(id); // Single entry
await ledger.retry(id); // Retry a failed entry
await ledger.remove(id); // Remove an entry
await ledger.clear(); // Remove all entries
await ledger.destroy(); // Close and cleanup
```

## Ledger Entry Schema

Each entry contains:

```ts
{
  id: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  };
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attemptCount: number;
  createdAt: number;       // ms since epoch
  lastAttemptAt?: number;
  error?: { message: string; code?: string };
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}
```

## Retry Strategies

```ts
// Fixed delay
{ type: 'fixed', delayMs: 1000, maxAttempts: 3 }

// Exponential backoff (default)
{ type: 'exponential', baseMs: 1000, maxMs: 30000, maxAttempts: 3 }

// Manual (user-triggered retries only)
{ type: 'manual' }
```

**Retry rules:**

- ✅ Retry on network errors
- ✅ Retry on 5xx server errors
- ❌ Never retry on 4xx client errors

## Custom Storage

Implement the `LedgerStorage` interface:

```ts
interface LedgerStorage {
  put(entry: LedgerEntry): Promise<void>;
  getAll(): Promise<LedgerEntry[]>;
  get(id: string): Promise<LedgerEntry | undefined>;
  update(id: string, patch: Partial<LedgerEntry>): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
}
```

## Failure Scenarios

| Scenario                      | Behavior                                         |
| ----------------------------- | ------------------------------------------------ |
| Offline when request made     | Persisted to IndexedDB, replayed when online     |
| Network fails mid-request     | Persisted, retried with backoff                  |
| Page closed during processing | Entry stays in `processing`, recovered on reload |
| 4xx response                  | Marked as `failed`, no retry                     |
| 5xx response                  | Retried up to `maxAttempts`                      |
| IndexedDB quota exceeded      | `PersistenceError` thrown                        |

## ⚠️ Backend Idempotency Required

**Your backend MUST support idempotency keys for safe replay.**

When a request is replayed, there's no guarantee the first attempt didn't succeed. Your backend must:

1. Accept an `X-Idempotency-Key` header
2. If the key was already processed, return the cached response
3. If new, process and cache the result

Without this, replayed requests may cause **duplicate side effects** (double charges, duplicate orders, etc.).

## Non-Goals

This library explicitly does **NOT**:

- ❌ Resolve application-level conflicts
- ❌ Sync application state
- ❌ Guess backend behavior
- ❌ Mutate request payloads
- ❌ Hide failures
- ❌ Depend on Service Workers

## Technical Details

- **Zero runtime dependencies**
- **TypeScript-first** with full type definitions
- **Tree-shakeable** ES modules
- **~8KB** gzipped
- Works in modern browsers (Chrome 80+, Firefox 75+, Safari 14+, Edge 80+)

## Example: Offline → Reload → Replay

```ts
// User creates an order while offline
await ledger.request({
  id: "order-456",
  url: "/api/orders",
  method: "POST",
  body: { product: "Widget", quantity: 5 },
  idempotencyKey: "order-456-v1",
});

// Entry is now persisted in IndexedDB
console.log(await ledger.list());
// [{ id: 'order-456', status: 'pending', ... }]

// --- User closes browser, reopens later ---

// On app startup, check for pending entries
const ledger = createLedger({
  /* config */
});
const state = await ledger.getState();

if (state === "pending") {
  // Process queued requests
  await ledger.process({
    onSuccess: (entry) => showNotification(`Order ${entry.id} completed!`),
    onFailure: (entry, error) =>
      showError(`Order ${entry.id} failed: ${error.message}`),
  });
}
```

## License

MIT
