// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
//
// Harness test untuk memanggil **worker kripto NYX yang asli**
// (`web/src/workers/crypto.worker.ts`) dari dalam vitest.
//
// Kenapa: uji lintas-implementasi (docs/30 WS-G(6)) hanya bermakna kalau yang
// diuji adalah kode yang benar-benar dipakai di produksi — bukan salinan logika
// di dalam test. Worker adalah Web Worker (`self.onmessage`/`self.postMessage`),
// sementara vitest berjalan di jsdom yang menyediakan `self`; jadi handler-nya
// bisa dipanggil langsung dengan menyadap `postMessage`.

import '../../../workers/crypto.worker';

interface WorkerEnvelope {
  success: boolean;
  id: string;
  result?: unknown;
  error?: string;
}

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
let counter = 0;
let installed = false;

/** Pasang penyadap `postMessage`. Idempoten (aman dipanggil berkali-kali). */
export function installWorkerHarness(): void {
  if (installed) return;
  installed = true;
  (self as unknown as { postMessage: (message: WorkerEnvelope) => void }).postMessage = (message) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.success) entry.resolve(message.result);
    else entry.reject(new Error(message.error ?? 'worker error tanpa pesan'));
  };
}

/** Panggil satu op worker. Menolak (reject) bila worker membalas error. */
export async function callWorker<T>(type: string, payload: unknown): Promise<T> {
  installWorkerHarness();
  const id = `harness-${++counter}`;
  const promise = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
  });
  const onmessage = (self as unknown as { onmessage: (event: { data: unknown }) => Promise<void> }).onmessage;
  if (typeof onmessage !== 'function') {
    throw new Error('worker crypto belum ter-import (self.onmessage tidak ada)');
  }
  // Handler worker bersifat async; error di dalamnya selalu dilaporkan lewat
  // pesan `{success:false}` (bukan throw), jadi tidak perlu try/catch di sini.
  await onmessage({ data: { type, payload, id } });
  return promise;
}

/** base64url (tanpa padding) → byte. Tidak memakai Buffer agar aman di jsdom. */
export function b64uToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
