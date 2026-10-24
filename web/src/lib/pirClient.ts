import type { UserSearchHit } from './userSearch';
import { getPirParams, PirError } from './pirParams';

const WORKER_TIMEOUT_MS = 30_000;
const PIR_QUERY_PATH = '/api/pir/query';

interface PirWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

type PirWorkerFactory = () => PirWorkerLike;
type OhttpFetch = (
  input: string,
  init?: { method?: string; headers?: [string, string][]; body?: Uint8Array; withToken?: boolean },
) => Promise<{ status: number; body: Uint8Array }>;

interface PendingCall {
  resolve: (value: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const defaultWorkerFactory: PirWorkerFactory = () => {
  if (typeof Worker === 'undefined') throw new PirError('PIR_WORKER_UNAVAILABLE');
  return new Worker(new URL('../workers/pir.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as PirWorkerLike;
};

let workerFactory: PirWorkerFactory = defaultWorkerFactory;
let worker: PirWorkerLike | null = null;
let workerEpoch: number | null = null;
let nextId = 1;
const pending = new Map<number, PendingCall>();

export function pirEnabled(): boolean {
  const value = (import.meta.env.VITE_PIR_ENABLED ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function failAll(error: Error): void {
  for (const call of pending.values()) {
    clearTimeout(call.timer);
    call.reject(error);
  }
  pending.clear();
}

function resetWorker(): void {
  failAll(new PirError('PIR_WORKER_TERMINATED'));
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }
  worker = null;
  workerEpoch = null;
}

function handleMessage(event: MessageEvent): void {
  const message = event.data as
    | { id: number; ok: true; result?: Uint8Array | ArrayBuffer }
    | { id: number; ok: false; error?: string };
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  clearTimeout(call.timer);
  if (message.ok) {
    const result = message.result;
    if (ArrayBuffer.isView(result)) {
      const view = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
      call.resolve(view.slice());
    } else if (result instanceof ArrayBuffer) {
      call.resolve(new Uint8Array(result));
    } else {
      call.resolve(new Uint8Array(0));
    }
    return;
  }
  call.reject(new PirError('PIR_WORKER', message.error ?? 'PIR_WORKER'));
}

function ensureWorker(): PirWorkerLike {
  if (worker) return worker;
  const created = workerFactory();
  created.onmessage = handleMessage;
  created.onerror = () => failAll(new PirError('PIR_WORKER', 'PIR_WORKER_ERROR'));
  created.onmessageerror = () => failAll(new PirError('PIR_WORKER', 'PIR_WORKER_MESSAGE'));
  worker = created;
  return created;
}

function callWorker(type: 'setup' | 'query' | 'process' | 'reset', payload: Record<string, unknown>): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new PirError('PIR_WORKER_TIMEOUT'));
    }, WORKER_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      ensureWorker().postMessage({ id, type, ...payload });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new PirError('PIR_WORKER'));
    }
  });
}

async function setupWorker(epoch: number, seed: Uint8Array, hint: Uint8Array, filter: Uint8Array): Promise<void> {
  if (workerEpoch === epoch) return;
  try {
    await callWorker('setup', { epoch, seed, hint, filter });
    workerEpoch = epoch;
  } catch (error) {
    workerEpoch = null;
    resetWorker();
    throw error;
  }
}

function hexToKey(value: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new PirError('PIR_INDEX_INVALID');
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i += 1) key[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return key;
}

function recordFromBytes(bytes: Uint8Array): UserSearchHit {
  const text = new TextDecoder().decode(bytes).trimEnd();
  if (!text) throw new PirError('PIR_RECORD_MISS');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PirError('PIR_RECORD_MISS');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PirError('PIR_RECORD_MISS');
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) throw new PirError('PIR_RECORD_MISS');
  return record as unknown as UserSearchHit;
}

async function searchOnce(
  params: Awaited<ReturnType<typeof getPirParams>>,
  key: Uint8Array,
  ohttpFetch: OhttpFetch,
): Promise<UserSearchHit | null> {
  await setupWorker(params.epoch, params.seed, params.hint, params.filter);
  const query = await callWorker('query', { epoch: params.epoch, oprf: key });
  const response = await ohttpFetch(PIR_QUERY_PATH, {
    method: 'POST',
    headers: [['content-type', 'application/octet-stream']],
    body: query,
  });
  if (response.status === 409) throw new PirError('PIR_EPOCH_STALE');
  if (response.status !== 200) throw new PirError('PIR_QUERY_HTTP', `PIR query HTTP ${response.status}`);

  let value: Uint8Array;
  try {
    value = await callWorker('process', { epoch: params.epoch, oprf: key, response: response.body });
  } catch (error) {
    if (error instanceof PirError && error.code === 'PIR_WORKER' && error.message.startsWith('PIR_PROCESS:')) {
      throw new PirError('PIR_RECORD_MISS', error.message);
    }
    throw error;
  }
  return recordFromBytes(value);
}

export async function pirSearch(oprfIndexHex: string): Promise<UserSearchHit | null> {
  const key = hexToKey(oprfIndexHex);
  const { ohttpEnabled, ohttpFetch } = await import('./ohttpClient');
  if (!ohttpEnabled()) throw new PirError('PIR_REQUIRES_OHTTP');

  const params = await getPirParams();
  try {
    return await searchOnce(params, key, ohttpFetch);
  } catch (error) {
    if (!(error instanceof PirError) || (error.code !== 'PIR_RECORD_MISS' && error.code !== 'PIR_EPOCH_STALE')) {
      throw error;
    }
    const fresh = await getPirParams({ force: true });
    if (error.code === 'PIR_RECORD_MISS' && fresh.epoch === params.epoch) return null;
    try {
      return await searchOnce(fresh, key, ohttpFetch);
    } catch (retryError) {
      if (retryError instanceof PirError && retryError.code === 'PIR_RECORD_MISS') return null;
      throw retryError;
    }
  }
}

export function _setPirWorkerFactoryForTests(factory: PirWorkerFactory | null): void {
  resetWorker();
  workerFactory = factory ?? defaultWorkerFactory;
}

export function _resetPirClientForTests(): void {
  resetWorker();
  workerFactory = defaultWorkerFactory;
  nextId = 1;
}
