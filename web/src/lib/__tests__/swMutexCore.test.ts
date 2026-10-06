import { describe, it, expect } from 'vitest';
import {
  createMutexRegistry,
  acquireLock,
  heartbeatLock,
  releaseLock,
  handleMutexRequest,
  LOCK_STALE_MS,
  type MutexRequest,
} from '../swMutexCore';

// Semantik registry mutex SW — semua sinkron & murni (tanpa DOM/SW nyata).

const REQ = <T extends MutexRequest['type']>(
  type: T,
  lockName: string,
  holderId: string,
  now: number
): Extract<MutexRequest, { type: T }> => ({ type, lockName, holderId, now }) as Extract<MutexRequest, { type: T }>;

describe('swMutexCore — exclusion sejati lintas-tab', () => {
  it('ACQUIRE kedua dari tab berbeda DITOLAK selagi pemegang masih fresh', () => {
    const reg = createMutexRegistry();
    const t0 = 1000;

    const a = acquireLock(reg, REQ('ACQUIRE', 'nyx:auth-refresh', 'tab-A', t0));
    expect(a).toEqual({ granted: true, holder: 'you' });

    const b = acquireLock(reg, REQ('ACQUIRE', 'nyx:auth-refresh', 'tab-B', t0 + 100));
    expect(b).toEqual({ granted: false, holder: 'other' });
  });

  it('re-entrant per tab: pemegang yang sama acquire ulang tetap granted', () => {
    const reg = createMutexRegistry();
    const t0 = 1000;

    expect(acquireLock(reg, REQ('ACQUIRE', 'L', 'tab-A', t0)).granted).toBe(true);
    expect(acquireLock(reg, REQ('ACQUIRE', 'L', 'tab-A', t0 + 500)).granted).toBe(true);
  });

  it('heartbeat mencegah lock di-sweep sebagai basi', () => {
    const reg = createMutexRegistry();
    const t0 = 1000;

    acquireLock(reg, REQ('ACQUIRE', 'L', 'tab-A', t0));
    heartbeatLock(reg, REQ('HEARTBEAT', 'L', 'tab-A', t0 + 3000));

    // Tanpa heartbeat sejak t0+3000; di t0+6000 (< 3000+4000) masih fresh.
    const b = acquireLock(reg, REQ('ACQUIRE', 'L', 'tab-B', t0 + 6000));
    expect(b.granted).toBe(false);
  });

  it('pemegang yang crash (tanpa heartbeat > LOCK_STALE_MS) kehilangan lock', () => {
    const reg = createMutexRegistry();
    const t0 = 1000;

    acquireLock(reg, REQ('ACQUIRE', 'L', 'tab-A', t0));
    // Tab-A crash — tidak pernah heartbeat lagi.
    const b = acquireLock(reg, REQ('ACQUIRE', 'L', 'tab-B', t0 + LOCK_STALE_MS + 1));
    expect(b).toEqual({ granted: true, holder: 'you' });
  });

  it('RELEASE dari pihak lain TIDAK melepas lock milik pemegang sah', () => {
    const reg = createMutexRegistry();
    const t0 = 1000;

    acquireLock(reg, REQ('ACQUIRE', 'L', 'tab-A', t0));
    const evil = releaseLock(reg, REQ('RELEASE', 'L', 'tab-evil', t0 + 100));
    expect(evil).toEqual({ granted: false, holder: 'other' });

    // Lock masih dipegang tab-A.
    expect(acquireLock(reg, REQ('ACQUIRE', 'L', 'tab-B', t0 + 200)).granted).toBe(false);
  });

  it('RELEASE oleh pemegang sah melepas lock → pemohon berikutnya granted', () => {
    const reg = createMutexRegistry();
    const t0 = 1000;

    acquireLock(reg, REQ('ACQUIRE', 'L', 'tab-A', t0));
    expect(releaseLock(reg, REQ('RELEASE', 'L', 'tab-A', t0 + 100)).granted).toBe(true);
    expect(acquireLock(reg, REQ('ACQUIRE', 'L', 'tab-B', t0 + 200)).granted).toBe(true);
  });

  it('sweep stale tidak mempengaruhi lock lain yang masih fresh', () => {
    const reg = createMutexRegistry();
    const t0 = 1000;

    acquireLock(reg, REQ('ACQUIRE', 'L-fresh', 'tab-A', t0 + 9000));
    acquireLock(reg, REQ('ACQUIRE', 'L-stale', 'tab-A', t0));
    // Operasi di t0+10000: L-stale basi, L-fresh (beat t0+9000) masih hidup.
    const res = handleMutexRequest(reg, REQ('ACQUIRE', 'L-fresh', 'tab-B', t0 + 10000));
    expect(res.granted).toBe(false);
    expect(handleMutexRequest(reg, REQ('ACQUIRE', 'L-stale', 'tab-B', t0 + 10000)).granted).toBe(true);
  });

  it('handleMutexRequest men-dispatch ketiga aksi', () => {
    const reg = createMutexRegistry();
    const t0 = 1000;

    expect(handleMutexRequest(reg, REQ('ACQUIRE', 'L', 'tab-A', t0)).granted).toBe(true);
    expect(handleMutexRequest(reg, REQ('HEARTBEAT', 'L', 'tab-A', t0 + 100)).granted).toBe(true);
    expect(handleMutexRequest(reg, REQ('RELEASE', 'L', 'tab-A', t0 + 200)).granted).toBe(true);
  });
});
