/** Developer-only fail-closed guard installed before any Firebase SDK evaluation. */
export interface GuardSnapshot {
  indexedDBOpenDenied: number;
  indexedDBDeleteDenied: number;
  storageWritesDenied: number;
  readRPCs: number;
  forbiddenRequestsDenied: number;
  requests: string[];
  ownerAuthorized: boolean;
}
const COLLECTION_CAPS: Record<string, number> = { healthWorkouts: 1001, halfMarathonRaces: 101, workoutOverrides: 1001, plans: 21 };
const PREFIX = 'projects/malignant-metro/databases/(default)/documents/';
export function assertReadRequest(url: string, method: string, body: unknown, uid: string | null): string | null {
  const parsed = new URL(url);
  if (parsed.hostname !== 'firestore.googleapis.com') {
    if (/firestore/i.test(parsed.hostname) || /\/firestore\//i.test(parsed.pathname)) throw new Error('Alternate Firestore endpoint denied');
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.port || method !== 'POST' || !uid || uid.includes('/')) throw new Error('Firestore request denied before owner authorization or outside read RPCs');
  if (typeof body !== 'string') throw new Error('Firestore read requires an inspectable JSON body');
  const data = JSON.parse(body) as Record<string, unknown>;
  const path = decodeURIComponent(parsed.pathname);
  const owner = `${PREFIX}users/${uid}`;
  if (path === `/v1/${owner}:runQuery`) {
    if (Object.keys(data).some(k => k !== 'structuredQuery')) throw new Error('Unexpected query envelope');
    const q = data.structuredQuery as Record<string, unknown>;
    if (!q || Object.keys(q).some(k => !['from', 'orderBy', 'limit', 'where'].includes(k))) throw new Error('Unexpected query fields');
    const from = q.from as { collectionId?: string; allDescendants?: boolean }[];
    const collection = from?.[0]?.collectionId ?? '';
    if (from?.length !== 1 || from[0].allDescendants || !COLLECTION_CAPS[collection]
      || typeof q.limit !== 'number' || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > COLLECTION_CAPS[collection]) throw new Error('Unbounded or forbidden parent query');
    return `POST parent query: ${collection}; limit ${q.limit}`;
  }
  if (path === `/v1/${PREFIX.slice(0, -1)}:batchGet`) {
    if (Object.keys(data).some(k => k !== 'documents') || !Array.isArray(data.documents)
      || data.documents.length !== 1 || typeof data.documents[0] !== 'string') throw new Error('Only one linked parent read per request is allowed');
    const parts = data.documents[0].slice(owner.length + 1).split('/');
    if (!data.documents[0].startsWith(owner + '/') || parts.length !== 2 || !parts[1]
      || !['healthWorkouts', 'plans'].includes(parts[0])) throw new Error('Only linked owner workout/plan parents are allowed');
    return `POST linked parent read: ${parts[0]}`;
  }
  throw new Error('Firestore RPC denied; only bounded owner parent reads are allowed');
}

export function installRuntimeGuard() {
  if (location.origin !== 'http://localhost:4186') throw new Error('Acceptance requires its dedicated http://localhost:4186 origin');
  const state: GuardSnapshot = { indexedDBOpenDenied: 0, indexedDBDeleteDenied: 0, storageWritesDenied: 0, readRPCs: 0, forbiddenRequestsDenied: 0, requests: [], ownerAuthorized: false };
  let uid: string | null = null;
  function inspect(url: string, method: string, body: unknown) {
    try {
      const label = assertReadRequest(url, method.toUpperCase(), body, uid);
      if (label) { state.readRPCs++; state.requests.push(label); }
    } catch (error) { state.forbiddenRequestsDenied++; throw error; }
  }
  // Never invoke native IndexedDB, even for Firebase heartbeat capability probes.
  const idb = globalThis.indexedDB;
  Object.defineProperty(idb, 'open', { configurable: false, writable: false, value: () => { state.indexedDBOpenDenied++; throw new DOMException('IndexedDB is prohibited in acceptance', 'SecurityError'); } });
  Object.defineProperty(idb, 'deleteDatabase', { configurable: false, writable: false, value: () => { state.indexedDBDeleteDenied++; throw new DOMException('IndexedDB deletion is prohibited in acceptance', 'SecurityError'); } });
  for (const method of ['setItem', 'removeItem', 'clear']) {
    Object.defineProperty(Storage.prototype, method, { configurable: false, writable: false, value: () => { state.storageWritesDenied++; throw new DOMException('Persistent browser storage is prohibited in acceptance', 'SecurityError'); } });
  }
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = input instanceof Request ? input : null;
    const body = init?.body ?? (request ? await request.clone().text() : undefined);
    inspect(new URL(url, location.href).href, init?.method ?? request?.method ?? 'GET', body);
    return originalFetch(input, init);
  };
  const metadata = new WeakMap<XMLHttpRequest, { url: string; method: string }>();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
    metadata.set(this, { url: new URL(String(url), location.href).href, method });
    return originalOpen.call(this, method, url, async, username, password);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const meta = metadata.get(this);
    if (!meta) { state.forbiddenRequestsDenied++; throw new Error('XHR without inspected open is prohibited'); }
    inspect(meta.url, meta.method, body);
    return originalSend.call(this, body);
  };
  return {
    authorizeOwner(ownerUid: string) {
      if (!ownerUid || ownerUid.includes('/') || uid) throw new Error('Owner binding invalid or already set');
      uid = ownerUid; state.ownerAuthorized = true;
    },
    revokeOwner() { uid = null; state.ownerAuthorized = false; },
    snapshot(): GuardSnapshot { return { ...state, requests: [...state.requests] }; },
  };
}
