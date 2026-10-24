/// <reference lib="webworker" />

import pirWasmUrl from '../../../packages/pir-wasm/dist/pir-client.wasm?url';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface PirExports {
  memory: WebAssembly.Memory;
  pir_alloc(len: number): number;
  pir_free(ptr: number, len: number): void;
  pir_setup(seedPtr: number, hintPtr: number, hintLen: number, filterPtr: number, filterLen: number): number;
  pir_query(oprfPtr: number): number;
  pir_process(oprfPtr: number, responsePtr: number, responseLen: number): number;
  pir_out_ptr(): number;
  pir_out_len(): number;
  pir_error_ptr(): number;
  pir_error_len(): number;
  pir_clear(): void;
}

type Request =
  | { id: number; type: 'setup'; epoch: number; seed: Uint8Array; hint: Uint8Array; filter: Uint8Array }
  | { id: number; type: 'query'; epoch: number; oprf: Uint8Array }
  | { id: number; type: 'process'; epoch: number; oprf: Uint8Array; response: Uint8Array }
  | { id: number; type: 'reset' };

let wasm: PirExports | null = null;
let loading: Promise<PirExports> | null = null;
let epoch: number | null = null;

async function getWasm(): Promise<PirExports> {
  if (wasm) return wasm;
  if (!loading) {
    loading = (async () => {
      const response = await fetch(pirWasmUrl);
      if (!response.ok) throw new Error(`PIR_WASM_HTTP_${response.status}`);
      const bytes = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance.exports as unknown as PirExports;
    })();
  }
  try {
    wasm = await loading;
    return wasm;
  } catch (error) {
    loading = null;
    throw error;
  }
}

function readError(api: PirExports): string {
  const len = api.pir_error_len();
  if (!len) return '';
  const ptr = api.pir_error_ptr();
  return new TextDecoder().decode(new Uint8Array(api.memory.buffer, ptr, len));
}

function readOutput(api: PirExports): Uint8Array {
  const len = api.pir_out_len();
  const ptr = api.pir_out_ptr();
  return new Uint8Array(api.memory.buffer, ptr, len).slice();
}

function alloc(api: PirExports, bytes: Uint8Array): { ptr: number; len: number } {
  const len = bytes.length;
  if (!len) return { ptr: 0, len: 0 };
  const ptr = api.pir_alloc(len);
  if (!ptr) throw new Error('PIR_WASM_ALLOC');
  new Uint8Array(api.memory.buffer, ptr, len).set(bytes);
  return { ptr, len };
}

function free(api: PirExports, allocation: { ptr: number; len: number }): void {
  if (allocation.ptr) api.pir_free(allocation.ptr, allocation.len);
}

function setup(api: PirExports, req: Extract<Request, { type: 'setup' }>): void {
  api.pir_clear();
  const seed = alloc(api, req.seed);
  const hint = alloc(api, req.hint);
  const filter = alloc(api, req.filter);
  try {
    const status = api.pir_setup(seed.ptr, hint.ptr, hint.len, filter.ptr, filter.len);
    if (status !== 0) throw new Error(`PIR_SETUP:${readError(api) || status}`);
  } finally {
    free(api, seed);
    free(api, hint);
    free(api, filter);
  }
  epoch = req.epoch;
}

function query(api: PirExports, req: Extract<Request, { type: 'query' }>): Uint8Array {
  if (epoch !== req.epoch) throw new Error('PIR_EPOCH_MISMATCH');
  const oprf = alloc(api, req.oprf);
  try {
    const status = api.pir_query(oprf.ptr);
    if (status !== 0) throw new Error(`PIR_QUERY:${readError(api) || status}`);
    return readOutput(api);
  } finally {
    free(api, oprf);
  }
}

function process(api: PirExports, req: Extract<Request, { type: 'process' }>): Uint8Array {
  if (epoch !== req.epoch) throw new Error('PIR_EPOCH_MISMATCH');
  const oprf = alloc(api, req.oprf);
  const response = alloc(api, req.response);
  try {
    const status = api.pir_process(oprf.ptr, response.ptr, response.len);
    if (status !== 0) throw new Error(`PIR_PROCESS:${readError(api) || status}`);
    return readOutput(api);
  } finally {
    free(api, oprf);
    free(api, response);
  }
}

ctx.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  try {
    const api = await getWasm();
    let result: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    if (req.type === 'setup') {
      setup(api, req);
    } else if (req.type === 'query') {
      result = query(api, req);
    } else if (req.type === 'process') {
      result = process(api, req);
    } else {
      api.pir_clear();
      epoch = null;
    }
    ctx.postMessage({ id: req.id, ok: true, result });
  } catch (error) {
    ctx.postMessage({ id: req.id, ok: false, error: error instanceof Error ? error.message : 'PIR_WORKER' });
  }
};
