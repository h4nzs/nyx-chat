// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.3] Kanal antar-tab: bentuk payload, penyaringan, dan
 * ketiadaan kanal. Yang dikunci di sini adalah janji privasi (payload hanya id
 * lokal) dan perilaku aman di lingkungan tanpa `BroadcastChannel`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  broadcastMessagesChanged,
  onDbBroadcast,
  resetDbBroadcastForTests,
} from '../dbBroadcast';

class FakeChannel {
  static instances: FakeChannel[] = [];
  readonly name: string;
  posted: unknown[] = [];
  closed = false;
  private listeners = new Set<(message: MessageEvent) => void>();

  constructor(name: string) {
    this.name = name;
    FakeChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    this.posted.push(data);
  }

  addEventListener(_type: 'message', listener: (message: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (message: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  /** Simulasi pesan dari tab lain. */
  emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data } as MessageEvent);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

function installFakeChannel(): void {
  vi.stubGlobal('BroadcastChannel', FakeChannel as unknown as typeof BroadcastChannel);
}

afterEach(() => {
  resetDbBroadcastForTests();
  FakeChannel.instances = [];
  vi.unstubAllGlobals();
});

describe('dbBroadcast', () => {
  it('mengirim id lokal saja pada kanal tetap `nyx-db`', () => {
    installFakeChannel();
    broadcastMessagesChanged('conv-1');
    broadcastMessagesChanged(null);

    expect(FakeChannel.instances).toHaveLength(1);
    expect(FakeChannel.instances[0]!.name).toBe('nyx-db');
    expect(FakeChannel.instances[0]!.posted).toEqual([
      { type: 'messages-changed', conversationId: 'conv-1' },
      { type: 'messages-changed', conversationId: null },
    ]);
  });

  it('meneruskan hanya pesan berbentuk benar dan berhenti setelah unsubscribe', () => {
    installFakeChannel();
    const seen: unknown[] = [];
    const stop = onDbBroadcast((event) => seen.push(event));
    const channel = FakeChannel.instances[0]!;

    channel.emit({ type: 'messages-changed', conversationId: 'conv-9' });
    channel.emit({ type: 'messages-changed', conversationId: null });
    channel.emit({ type: 'messages-changed' });
    channel.emit({ type: 'lain', conversationId: 'conv-9' });
    channel.emit('bukan-objek');

    expect(seen).toEqual([
      { type: 'messages-changed', conversationId: 'conv-9' },
      { type: 'messages-changed', conversationId: null },
    ]);

    stop();
    expect(channel.listenerCount).toBe(0);
    channel.emit({ type: 'messages-changed', conversationId: 'conv-9' });
    expect(seen).toHaveLength(2);
  });

  it('tanpa BroadcastChannel: tidak melempar dan subscriber tidak terdaftar', () => {
    vi.stubGlobal('BroadcastChannel', undefined);

    expect(() => broadcastMessagesChanged('conv-1')).not.toThrow();
    const stop = onDbBroadcast(() => {});
    expect(() => stop()).not.toThrow();
  });
});
