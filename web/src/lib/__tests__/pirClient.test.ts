import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../pirParams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pirParams')>();
  return { ...actual, getPirParams: vi.fn() };
});
vi.mock('../ohttpClient', () => ({
  ohttpEnabled: vi.fn(),
  ohttpFetch: vi.fn(),
}));

import { getPirParams } from '../pirParams';
import { ohttpEnabled, ohttpFetch } from '../ohttpClient';
import {
  _resetPirClientForTests,
  _setPirWorkerFactoryForTests,
  pirSearch,
} from '../pirClient';

type WorkerReply = { id: number; ok: boolean; result?: Uint8Array; error?: string };

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  processResults: Array<Uint8Array | Error> = [];

  postMessage(message: Record<string, unknown>): void {
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.type === 'process') {
        const next = this.processResults.shift();
        if (!next) throw new Error('process reply belum disiapkan');
        if (next instanceof Error) {
          this.reply({ id: message.id as number, ok: false, error: next.message });
        } else {
          this.reply({ id: message.id as number, ok: true, result: next });
        }
        return;
      }
      this.reply({
        id: message.id as number,
        ok: true,
        result: message.type === 'query' ? new Uint8Array([9, 8, 7]) : new Uint8Array(0),
      });
    });
  }

  private reply(message: WorkerReply): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  terminate(): void {}
}

const paramsEpoch1 = {
  epoch: 1,
  recordBytes: 256,
  entryCount: 8,
  suite: 'chalametpir-v1' as const,
  seed: new Uint8Array(32),
  hint: new Uint8Array(4),
  filter: new Uint8Array(4),
  etag: '"pir-1"',
};

const paramsEpoch2 = { ...paramsEpoch1, epoch: 2, etag: '"pir-2"' };

function recordBytes(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ id: 'user-1', publicKey: 'pk-1' }) + '  ');
}

describe('pirClient', () => {
  beforeEach(() => {
    _resetPirClientForTests();
    vi.mocked(getPirParams).mockReset();
    vi.mocked(ohttpEnabled).mockReset();
    vi.mocked(ohttpFetch).mockReset();
    vi.mocked(ohttpEnabled).mockReturnValue(true);
    vi.mocked(ohttpFetch).mockResolvedValue({ status: 200, body: new Uint8Array([1, 2, 3]), headers: [] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetPirClientForTests();
  });

  it('mengambil record lewat worker dan OHTTP', async () => {
    const worker = new FakeWorker();
    worker.processResults = [recordBytes()];
    _setPirWorkerFactoryForTests(() => worker);
    vi.mocked(getPirParams).mockResolvedValue(paramsEpoch1);

    await expect(pirSearch('ab'.repeat(32))).resolves.toMatchObject({ id: 'user-1' });
    expect(vi.mocked(ohttpFetch)).toHaveBeenCalledWith('/api/pir/query', {
      method: 'POST',
      headers: [['content-type', 'application/octet-stream']],
      body: new Uint8Array([9, 8, 7]),
    });
    expect(worker.sent.map((m) => m.type)).toEqual(['setup', 'query', 'process']);
  });

  it('mengembalikan null saat record tidak ada dan epoch tidak berubah', async () => {
    const worker = new FakeWorker();
    worker.processResults = [new Error('PIR_PROCESS: digest mismatch')];
    _setPirWorkerFactoryForTests(() => worker);
    vi.mocked(getPirParams)
      .mockResolvedValueOnce(paramsEpoch1)
      .mockResolvedValueOnce(paramsEpoch1);

    await expect(pirSearch('cd'.repeat(32))).resolves.toBeNull();
    expect(vi.mocked(getPirParams)).toHaveBeenCalledWith({ force: true });
    expect(vi.mocked(ohttpFetch)).toHaveBeenCalledTimes(1);
  });

  it('retry sekali setelah epoch berubah', async () => {
    const worker = new FakeWorker();
    worker.processResults = [new Error('PIR_PROCESS: digest mismatch'), recordBytes()];
    _setPirWorkerFactoryForTests(() => worker);
    vi.mocked(getPirParams)
      .mockResolvedValueOnce(paramsEpoch1)
      .mockResolvedValueOnce(paramsEpoch2);

    await expect(pirSearch('ef'.repeat(32))).resolves.toMatchObject({ id: 'user-1' });
    expect(vi.mocked(ohttpFetch)).toHaveBeenCalledTimes(2);
    expect(worker.sent.filter((m) => m.type === 'setup')).toHaveLength(2);
  });

  it('menolak PIR saat OHTTP mati', async () => {
    vi.mocked(ohttpEnabled).mockReturnValue(false);
    await expect(pirSearch('12'.repeat(32))).rejects.toMatchObject({
      code: 'PIR_REQUIRES_OHTTP',
    });
    expect(vi.mocked(ohttpFetch)).not.toHaveBeenCalled();
  });

  it('menolak index OPRF yang bukan 32 byte hex', async () => {
    await expect(pirSearch('bukan-hex')).rejects.toMatchObject({ code: 'PIR_INDEX_INVALID' });
  });
});
