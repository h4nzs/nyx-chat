let worker: Worker | null = null;
let messageId = 0;
let workerReady = false;
let workerError: Error | null = null;
const messageQueue: Array<{ id: number, type: string, table: string, payload: any }> = [];
const pendingRequests = new Map<number, { resolve: (data: any) => void; reject: (err: any) => void, timeout: ReturnType<typeof setTimeout> }>();

export function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../../../workers/pglite.worker.ts', import.meta.url), { type: 'module' });
    
    const handleFatalError = (err: any) => {
        console.error('[db-proxy] Fatal worker error:', err);
        workerError = new Error(err instanceof Error ? err.message : String(err));
        
        // Reject all pending requests
        for (const [reqId, pending] of pendingRequests.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(workerError);
        }
        pendingRequests.clear();
        messageQueue.length = 0;
    };

    worker.onerror = (e) => handleFatalError(e.message || 'Worker load error');
    worker.onmessageerror = (e) => handleFatalError('Worker message error');

    worker.onmessage = (e) => {
      const { id, result, error, type } = e.data;
      
      if (type === 'READY') {
          console.log('[db-proxy] Worker Ready');
          workerReady = true;
          // Flush the queue
          while (messageQueue.length > 0) {
              const msg = messageQueue.shift();
              if (msg) worker!.postMessage(msg);
          }
          return;
      }
      
      if (type === 'ERROR' && !id) {
          handleFatalError(error);
          return;
      }

      const pending = pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
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
  
  if (workerError) {
      throw workerError;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
        if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error(`[db-proxy] Request ${id} timeout after 15000ms (${type} on ${table})`));
        }
    }, 15000);

    pendingRequests.set(id, { resolve, reject, timeout });
    
    const msg = { id, type, table, payload };
    if (workerReady) {
        w.postMessage(msg);
    } else {
        messageQueue.push(msg);
    }
  });
}
