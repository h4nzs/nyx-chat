// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Jitter/batching kirim mode Maximum.
 * Yang dikunci: rentang jeda 200–800 ms, pesan dalam jendela yang sama dilepas
 * BERSAMA tanpa mengubah urutan, dan silent/percakapan non-Maximum tidak
 * pernah ditahan.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAXIMUM_SEND_JITTER_MAX_MS,
  MAXIMUM_SEND_JITTER_MIN_MS,
  MaximumSendGate,
  _resetSendTimingForTests,
  applyMaximumSendDelay,
  isMaximumSendConversation,
  planSendDelay,
} from '../sendTiming';

describe('planSendDelay', () => {
  it('selalu dalam [200, 800] ms', () => {
    for (const value of [0, 0.01, 0.5, 0.99, 1]) {
      const delay = planSendDelay(() => value);
      expect(delay).toBeGreaterThanOrEqual(MAXIMUM_SEND_JITTER_MIN_MS);
      expect(delay).toBeLessThanOrEqual(MAXIMUM_SEND_JITTER_MAX_MS);
    }
  });

  it('nilai rng di luar [0,1] tetap di-clamp', () => {
    expect(planSendDelay(() => -1)).toBe(MAXIMUM_SEND_JITTER_MIN_MS);
    expect(planSendDelay(() => 5)).toBe(MAXIMUM_SEND_JITTER_MAX_MS);
  });
});

describe('isMaximumSendConversation', () => {
  it('burner selalu Maximum, grup biasa hanya bila terdaftar', () => {
    expect(isMaximumSendConversation('burner_abc', [])).toBe(true);
    expect(isMaximumSendConversation('conv-1', ['conv-1'])).toBe(true);
    expect(isMaximumSendConversation('conv-1', ['conv-2'])).toBe(false);
  });
});

describe('MaximumSendGate', () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetSendTimingForTests();
  });

  it('menggabungkan pesan dalam satu jendela dan melepasnya berurutan', async () => {
    vi.useFakeTimers();
    const gate = new MaximumSendGate();
    const order: string[] = [];
    void gate.delay('conv-1', () => 1).then(() => order.push('first'));
    void gate.delay('conv-1', () => 1).then(() => order.push('second'));

    expect(gate.pending('conv-1')).toBe(2);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(MAXIMUM_SEND_JITTER_MAX_MS + 1);
    expect(order).toEqual(['first', 'second']);
    expect(gate.pending('conv-1')).toBe(0);
  });

  it('percakapan berbeda punya jendela sendiri', async () => {
    vi.useFakeTimers();
    const gate = new MaximumSendGate();
    const released: string[] = [];
    void gate.delay('conv-a', () => 0).then(() => released.push('a'));
    void gate.delay('conv-b', () => 0).then(() => released.push('b'));

    await vi.advanceTimersByTimeAsync(MAXIMUM_SEND_JITTER_MIN_MS + 1);
    expect(released.sort()).toEqual(['a', 'b']);
  });

  it('flushAll melepas penunggu segera (tab ditutup/test)', async () => {
    vi.useFakeTimers();
    const gate = new MaximumSendGate();
    let done = false;
    void gate.delay('conv-1').then(() => { done = true; });
    gate.flushAll();
    await Promise.resolve();
    expect(done).toBe(true);
  });
});

describe('applyMaximumSendDelay', () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetSendTimingForTests();
  });

  it('tidak menahan pesan silent', async () => {
    vi.useFakeTimers();
    let done = false;
    void applyMaximumSendDelay('conv-1', { silent: true, maximumGroups: ['conv-1'] })
      .then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('tidak menahan percakapan non-Maximum', async () => {
    vi.useFakeTimers();
    let done = false;
    void applyMaximumSendDelay('conv-1', { maximumGroups: [] }).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('menahan pesan user pada percakapan Maximum sampai jendela tutup', async () => {
    vi.useFakeTimers();
    let done = false;
    void applyMaximumSendDelay('conv-1', { maximumGroups: ['conv-1'] }).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(MAXIMUM_SEND_JITTER_MAX_MS + 1);
    expect(done).toBe(true);
  });
});
