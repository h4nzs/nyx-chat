let worker: Worker | null = null;
let messageId = 0;
const pendingRequests = new Map<number, { resolve: (data: any) => void; reject: (err: any) => void }>();

export function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../../workers/pglite.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, result, error, type } = e.data;
      if (type === 'READY') {
          console.log('[db-proxy] Worker Ready');
          return;
      }
      const pending = pendingRequests.get(id);
      if (pending) {
        pendingRequests.delete(id);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
      }
    };
  }
  return worker;
}

export async function dbRequest(type: string, table: string, payload: any): Promise<any> {
  const id = ++messageId;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    w.postMessage({ id, type, table, payload });
  });
}
