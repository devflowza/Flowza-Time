import type { SelfPunchDirection } from '@flowza/contracts';

/**
 * Offline check-in queue (HR portal Prompt 4). A punch taken while the device has no connection is kept in IndexedDB and sent
 * when the connection returns. The server records ITS OWN time for every punch — the device time a punch was queued at
 * travels as `clientQueuedAt` for information only — and each queued punch carries the idempotency key it was created with,
 * so a replay that raced a successful send can never record the punch twice.
 *
 * Environments without IndexedDB (a private window that refuses it, jsdom in tests) fall back to an in-memory store: the
 * queue then survives navigation but not a reload, which is the best that can be done there.
 */
export interface QueuedPunch {
  /** The idempotency key of the punch (also the store key). */
  key: string;
  orgId: string;
  direction: SelfPunchDirection;
  lat?: number | undefined;
  lng?: number | undefined;
  accuracy?: number | undefined;
  /** Device time the punch was taken (ISO). */
  clientQueuedAt: string;
  attempts: number;
  lastError: string | null;
}

export interface PunchQueueStore {
  all(): Promise<QueuedPunch[]>;
  put(p: QueuedPunch): Promise<void>;
  remove(key: string): Promise<void>;
}

const DB_NAME = 'flowza-offline';
const STORE = 'punches';

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed')); });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

export function createIdbStore(): PunchQueueStore {
  let db: Promise<IDBDatabase> | null = null;
  const conn = () => (db ??= openDb());
  const tx = async (mode: IDBTransactionMode) => (await conn()).transaction(STORE, mode).objectStore(STORE);
  return {
    async all() { return (await idbRequest((await tx('readonly')).getAll())) as QueuedPunch[]; },
    async put(p) { await idbRequest((await tx('readwrite')).put(p)); },
    async remove(key) { await idbRequest((await tx('readwrite')).delete(key)); },
  };
}

export function createMemoryStore(): PunchQueueStore {
  const items = new Map<string, QueuedPunch>();
  return {
    async all() { return [...items.values()].map((p) => ({ ...p })); },
    async put(p) { items.set(p.key, { ...p }); },
    async remove(key) { items.delete(key); },
  };
}

/** One store per page load; IndexedDB when the browser offers it, memory otherwise (see the note above). */
let shared: PunchQueueStore | null = null;
export function punchQueueStore(): PunchQueueStore {
  if (shared) return shared;
  const memory = createMemoryStore();
  if (typeof indexedDB === 'undefined') return (shared = memory);
  const idb = createIdbStore();
  // a browser that has indexedDB but refuses it (storage disabled) degrades to memory on the first failure
  let failed = false;
  const guarded = <A extends unknown[], R>(fn: (s: PunchQueueStore) => (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    if (!failed) {
      try { return await fn(idb)(...a); } catch { failed = true; }
    }
    return fn(memory)(...a);
  };
  shared = { all: guarded((s) => s.all), put: guarded((s) => s.put), remove: guarded((s) => s.remove) };
  return shared;
}
/** Tests swap the store (e.g. to pre-fill it). */
export function setPunchQueueStore(store: PunchQueueStore | null): void { shared = store; }

/** Queued punches of one organisation, oldest first (they are replayed in the order they were taken). */
export async function queuedPunches(store: PunchQueueStore, orgId: string): Promise<QueuedPunch[]> {
  return (await store.all()).filter((p) => p.orgId === orgId).sort((a, b) => a.clientQueuedAt.localeCompare(b.clientQueuedAt));
}

/** What sending one punch produced: recorded (or replayed), refused for good (with the reason), or try again later. */
export type SendOutcome = { kind: 'sent' } | { kind: 'refused'; reason: string } | { kind: 'retry'; error: string };
export interface ReplayResult { sent: number; refused: Array<{ punch: QueuedPunch; reason: string }>; remaining: number; stoppedEarly: boolean }

/**
 * Send the organisation's queued punches in order. A sent or refused punch leaves the queue (a refusal is final: the server
 * judged it); the first "retry" (still offline, a 5xx) stops the run so the order of the rest is kept.
 */
export async function replayQueue(store: PunchQueueStore, orgId: string, send: (p: QueuedPunch) => Promise<SendOutcome>): Promise<ReplayResult> {
  const queue = await queuedPunches(store, orgId);
  const result: ReplayResult = { sent: 0, refused: [], remaining: queue.length, stoppedEarly: false };
  for (const p of queue) {
    const outcome = await send(p);
    if (outcome.kind === 'retry') {
      await store.put({ ...p, attempts: p.attempts + 1, lastError: outcome.error });
      result.stoppedEarly = true;
      break;
    }
    await store.remove(p.key);
    result.remaining -= 1;
    if (outcome.kind === 'sent') result.sent += 1;
    else result.refused.push({ punch: p, reason: outcome.reason });
  }
  return result;
}
