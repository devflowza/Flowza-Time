import type { SelfPunchDirection } from '@flowza/contracts';

/**
 * Offline check-in queue (HR portal Prompt 4). A punch taken while the device has no connection is kept in IndexedDB and sent
 * when the connection returns. The server records ITS OWN time for every punch — the device time a punch was queued at
 * travels as `clientQueuedAt` for information only — and each queued punch carries the idempotency key it was created with,
 * so a replay that raced a successful send can never record the punch twice.
 *
 * Environments without IndexedDB (a private window that refuses it, jsdom in tests) fall back to an in-memory store: the
 * queue then survives navigation but not a reload, which is the best that can be done there.
 *
 * Every queued punch belongs to the USER who took it and the organisation it was taken in (HR portal Prompt 4 review, P0-3):
 * it is shown, replayed and discarded only under that user's own session — a browser shared by two people (a kiosk, a family
 * device) never sends one person's punch, location and idempotency key as the other's. Signing out leaves other people's
 * punches where they are (their owner sends them when they sign in again). Punches saved before the queue knew its users
 * cannot be attributed to anybody: they are removed once, with a notice, and never sent.
 */
export interface QueuedPunch {
  /** The idempotency key of the punch (also the store key). */
  key: string;
  /** The signed-in user who took the punch. */
  userId: string;
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

/** True when the queued punch was taken by this user in this organisation — the only punches they may see, send or discard. */
export const ownPunch = (p: Pick<QueuedPunch, 'userId' | 'orgId'>, orgId: string, userId: string): boolean => p.orgId === orgId && typeof p.userId === 'string' && p.userId === userId;

/** The signed-in user's queued punches in one organisation, oldest first (they are replayed in the order they were taken). */
export async function queuedPunches(store: PunchQueueStore, orgId: string, userId: string): Promise<QueuedPunch[]> {
  return (await store.all()).filter((p) => ownPunch(p, orgId, userId)).sort((a, b) => a.clientQueuedAt.localeCompare(b.clientQueuedAt));
}

/**
 * Remove the punches saved before the queue recorded who took them (review P0-3): nobody can tell whose they are, so they
 * are never sent. Returns how many were removed (the page tells the employee once — the next time there are none).
 */
export async function purgeUnattributed(store: PunchQueueStore): Promise<number> {
  const orphans = (await store.all()).filter((p) => typeof (p as Partial<QueuedPunch>).userId !== 'string' || !(p as Partial<QueuedPunch>).userId);
  for (const p of orphans) await store.remove(p.key);
  return orphans.length;
}

/** Remove one queued punch — only the signed-in user's own. Returns false when it is somebody else's (or gone). */
export async function discardOwn(store: PunchQueueStore, orgId: string, userId: string, key: string): Promise<boolean> {
  const item = (await store.all()).find((p) => p.key === key);
  if (!item || !ownPunch(item, orgId, userId)) return false;
  await store.remove(key);
  return true;
}

/** What sending one punch produced: recorded (or replayed), refused for good (with the reason), or try again later. */
export type SendOutcome = { kind: 'sent' } | { kind: 'refused'; reason: string } | { kind: 'retry'; error: string };
export interface ReplayResult { sent: number; refused: Array<{ punch: QueuedPunch; reason: string }>; remaining: number; stoppedEarly: boolean }

/**
 * Send the signed-in user's queued punches of the organisation in order — nobody else's. A sent or refused punch leaves the
 * queue (a refusal is final: the server judged it); the first "retry" (still offline, a 5xx, a duplicate the server holds for
 * the OTHER direction) stops the run so the order of the rest is kept.
 */
export async function replayQueue(store: PunchQueueStore, orgId: string, userId: string, send: (p: QueuedPunch) => Promise<SendOutcome>): Promise<ReplayResult> {
  const queue = await queuedPunches(store, orgId, userId);
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
