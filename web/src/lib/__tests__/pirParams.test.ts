import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  getApiBaseUrl: () => '',
  getClientInstallationId: async () => 'install-pir',
}));
vi.mock('../clientVersion', () => ({
  clientVersionHeaders: () => ({ 'x-nyx-client-version': 'test' }),
}));

import {
  PIR_SUITE,
  _resetPirParamsForTests,
  getPirParams,
  parsePirParams,
} from '../pirParams';

function b64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function paramsBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    epoch: 1,
    recordBytes: 256,
    entryCount: 8,
    suite: PIR_SUITE,
    seed: b64(new Uint8Array(32).fill(7)),
    hint: b64(new Uint8Array([1, 2, 3, 4])),
    filter: b64(new Uint8Array([5, 6, 7, 8])),
    ...overrides,
  });
}

function response(body: string, status = 200, etag = '"pir-1"') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
    text: async () => body,
  } as unknown as Response;
}

describe('pirParams', () => {
  beforeEach(() => {
    _resetPirParamsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetPirParamsForTests();
  });

  it('mem-parse params kanonik dan men-decode seed/hint/filter', () => {
    const params = parsePirParams(paramsBody(), '"pir-1"');
    expect(params.epoch).toBe(1);
    expect(params.recordBytes).toBe(256);
    expect(params.entryCount).toBe(8);
    expect(params.suite).toBe(PIR_SUITE);
    expect(params.seed).toHaveLength(32);
    expect(Array.from(params.hint)).toEqual([1, 2, 3, 4]);
    expect(Array.from(params.filter)).toEqual([5, 6, 7, 8]);
    expect(params.etag).toBe('"pir-1"');
  });

  it('menolak suite, ukuran seed, dan recordBytes yang tidak valid', () => {
    function expectInvalid(fn: () => unknown) {
      try {
        fn();
      } catch (error) {
        expect(error).toMatchObject({ code: 'PIR_PARAMS_INVALID' });
        return;
      }
      throw new Error('params seharusnya ditolak');
    }
    expectInvalid(() => parsePirParams(paramsBody({ suite: 'lain' }), ''));
    expectInvalid(() => parsePirParams(paramsBody({ seed: b64(new Uint8Array(31)) }), ''));
    expectInvalid(() => parsePirParams(paramsBody({ recordBytes: 128 }), ''));
    expectInvalid(() => parsePirParams(paramsBody({ hint: '' }), ''));
  });

  it('meng-cache params dan memakai ETag saat force refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(paramsBody()))
      .mockResolvedValueOnce(response('', 304, '"pir-1"'));
    vi.stubGlobal('fetch', fetchMock);

    const first = await getPirParams();
    expect(first.epoch).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cached = await getPirParams();
    expect(cached.epoch).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const refreshed = await getPirParams({ force: true });
    expect(refreshed.epoch).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = (fetchMock.mock.calls[1]?.[1] ?? {}) as RequestInit;
    expect((request.headers as Record<string, string>)['If-None-Match']).toBe('"pir-1"');
  });

  it('meneruskan error HTTP params tanpa fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('nope', 503)));
    await expect(getPirParams()).rejects.toMatchObject({ code: 'PIR_PARAMS_HTTP' });
  });

  it('berbagi satu unduhan params untuk panggilan bersamaan', async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetchMock);

    const first = getPirParams();
    const second = getPirParams();
    release(response(paramsBody()));
    const [a, b] = await Promise.all([first, second]);

    expect(a.epoch).toBe(1);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('memetakan body yang abort ke PIR_PARAMS_UNAVAILABLE dan bisa dicoba lagi', async () => {
    const broken = response('');
    broken.text = async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(response(paramsBody()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPirParams()).rejects.toMatchObject({ code: 'PIR_PARAMS_UNAVAILABLE' });
    const retried = await getPirParams();
    expect(retried.epoch).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
