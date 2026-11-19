import type { SqlDriver, SqlStatement, SqlValue } from './types';

type RequestPayload =
  | { type: 'open'; key: Uint8Array; dbName?: string }
  | { type: 'exec'; sql: string }
  | { type: 'all'; sql: string; params?: SqlValue[] }
  | { type: 'run'; sql: string; params?: SqlValue[] }
  | { type: 'batch'; statements: SqlStatement[] }
  | { type: 'close' };

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * [docs/43 §43.11.6 B1] Klien main-thread untuk worker SQLite OPFS.
 *
 * Objek ini belum dipakai aplikasi; B2 yang memindahkan pembaca ke sini.
 * Kunci ditransfer ke worker (buffer pemanggil menjadi detached) dan
 * di-zero-kan di sana setelah `PRAGMA key`.
 */
export class SqliteWorkerClient implements SqlDriver {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error ?? 'SQLite worker error'));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'SQLite worker crash');
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
    };
  }

  static async open(options: {
    key: Uint8Array;
    dbName?: string;
  }): Promise<SqliteWorkerClient> {
    const worker = new Worker(new URL('./sqlite.worker.ts', import.meta.url), {
      type: 'module',
      name: 'nyx-sqlite',
    });
    const client = new SqliteWorkerClient(worker);
    const transfer = options.key.buffer instanceof ArrayBuffer
      ? [options.key.buffer]
      : [];
    await client.request(
      { type: 'open', key: options.key, dbName: options.dbName },
      transfer,
    );
    return client;
  }

  exec(sql: string): Promise<void> {
    return this.request<void>({ type: 'exec', sql });
  }

  all<T = Record<string, unknown>>(
    sql: string,
    params?: SqlValue[],
  ): Promise<T[]> {
    return this.request<T[]>({ type: 'all', sql, params });
  }

  run(sql: string, params?: SqlValue[]): Promise<void> {
    return this.request<void>({ type: 'run', sql, params });
  }

  batch(statements: SqlStatement[]): Promise<void> {
    return this.request<void>({ type: 'batch', statements });
  }

  async close(): Promise<void> {
    try {
      await this.request<void>({ type: 'close' });
    } finally {
      this.#worker.terminate();
    }
  }

  private request<T>(
    payload: RequestPayload,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`SQLite worker timeout setelah ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.#worker.postMessage({ ...payload, id }, transfer);
    });
  }
}
