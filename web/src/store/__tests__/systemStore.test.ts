/**
 * systemStore.checkStatus — deteksi server tak terjangkau.
 * `api` di-stub (tidak butuh Postgres/Redis/jaringan).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: (...a: unknown[]) => apiMock(...a) };
});

import { ApiError } from '../../lib/api';
import { useSystemStore } from '../systemStore';

const OK = { maintenance: false, banner: { active: false, message: '', type: 'info' } };

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useSystemStore.setState({ maintenance: false, serverUnreachable: false });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const run = async () => {
  const p = useSystemStore.getState().checkStatus();
  await vi.advanceTimersByTimeAsync(3000);
  await p;
};

describe('checkStatus', () => {
  it('sukses → serverUnreachable=false & menyalin maintenance', async () => {
    apiMock.mockResolvedValue({ ...OK, maintenance: true });
    await run();
    expect(useSystemStore.getState()).toMatchObject({ serverUnreachable: false, maintenance: true });
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 8000 });
  });

  it('gagal 2x berturut-turut (503) → serverUnreachable=true', async () => {
    apiMock.mockRejectedValue(new ApiError(503, 'server_unreachable'));
    await run();
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(useSystemStore.getState().serverUnreachable).toBe(true);
  });

  it('blip tunggal (gagal lalu sukses) → TIDAK menutup layar', async () => {
    apiMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(OK);
    await run();
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(useSystemStore.getState().serverUnreachable).toBe(false);
  });

  it('pulih → serverUnreachable kembali false', async () => {
    useSystemStore.setState({ serverUnreachable: true });
    apiMock.mockResolvedValue(OK);
    await run();
    expect(useSystemStore.getState().serverUnreachable).toBe(false);
  });

  it('error aplikasi (500/401) bukan server-down & tidak di-retry', async () => {
    apiMock.mockRejectedValue(new ApiError(500, 'oops'));
    await run();
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(useSystemStore.getState().serverUnreachable).toBe(false);
  });

  it('single-flight: panggilan paralel berbagi satu request', async () => {
    apiMock.mockResolvedValue(OK);
    const a = useSystemStore.getState().checkStatus();
    const b = useSystemStore.getState().checkStatus();
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([a, b]);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
