// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Test paritas gateway WSS vs jalur WebTransport [backlog audit].
 *
 * Kontrak: klien di jaringan yang memblokir QUIC harus mendapatkan perilaku
 * server yang SETARA melalui fallback socket.io (gateway.ts) — event KEY_SYNC
 * apa pun yang bisa dikirim lewat WT (redisBridge → handleKeySync) harus bisa
 * dikirim lewat WSS juga, dengan nama event dan payload yang sama.
 *
 * Cara kerja test ini:
 *  1. `WSS_KEYS_SYNC_EVENTS` (diekspor gateway.ts) adalah sumber kebenaran
 *     daftar event yang didaftarkan gateway WSS pada socket.io.
 *  2. `handleKeySync` punya satu `switch (event)` — daftar case-nya diurai
 *     dari source file. Penguraian source memang rapuh terhadap refactor besar,
 *     tapi itulah gunanya test ini: jika switch berubah tanpa menyelaraskan
 *     gateway (atau sebaliknya), test gagal dan memaksa review.
 *  3. Paritas ACK/presence/chat (jalur fixed, bukan KEY_SYNC) dicek lewat
 *     pemindaian `socket.on(` di gateway.
 *
 * Yang dijamin:
 *  - Semua event yang dikirim client WSS (derived dari payload.event KEY_SYNC)
 *    diterima server — tidak ada "pintu kosong" di mode WSS.
 *  - Tidak ada event gateway yang tak dikenal handleKeySync (typo / event basi).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WSS_KEYS_SYNC_EVENTS } from '../src/realtime/gateway.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const handlersSource = readFileSync(
  path.join(here, '../src/network/realtimeHandlers.ts'),
  'utf8'
);
const gatewaySource = readFileSync(
  path.join(here, '../src/realtime/gateway.ts'),
  'utf8'
);

/** Case di dalam switch(event) handleKeySync. */
function extractHandledKeySyncEvents(source: string): string[] {
  // Ambil blok function handleKeySync … sampai penutup switch-nya.
  const fnStart = source.indexOf('export async function handleKeySync');
  assert.ok(fnStart >= 0, 'handleKeySync harus ada di realtimeHandlers.ts');
  const fnSource = source.slice(fnStart, source.indexOf('\n}', fnStart) + 2);

  const cases = new Set<string>();
  const re = /case\s+'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnSource)) !== null) cases.add(m[1]!);
  return [...cases].sort();
}

/** Event yang didaftarkan socket.on(...) di gateway (semua inbound). */
function extractGatewaySocketEvents(source: string): string[] {
  const events = new Set<string>();
  const re = /socket\.on\('([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) events.add(m[1]!);
  return [...events].sort();
}

test('WSS_KEYS_SYNC_EVENTS non-kosong dan unik', () => {
  assert.ok(WSS_KEYS_SYNC_EVENTS.length >= 20, 'minimal 20 event KEY_SYNC');
  assert.equal(new Set(WSS_KEYS_SYNC_EVENTS).size, WSS_KEYS_SYNC_EVENTS.length, 'tidak ada duplikat');
});

test('setiap event gateway WSS punya case di handleKeySync (tidak ada event basi/typo)', () => {
  const handled = new Set(extractHandledKeySyncEvents(handlersSource));
  const missing = WSS_KEYS_SYNC_EVENTS.filter((e) => !handled.has(e));
  assert.deepEqual(missing, [], 'event diteruskan gateway tapi tak ditangani handler');
});

test('setiap case handleKeySync bisa dicapai dari WSS ATAU di-dokumentasikan sebagai gap WT-only', () => {
  // Gap yang DIKETAHUI dan aman: event ini hanya dikirim client via jalur fixed
  // (bukan derived KEY_SYNC) atau belum dipakai client WSS sama sekali.
  //  - message:ack_delivered  → jalur fixed ACK (gateway socket.on terpisah).
  //  - messages:mark_*        → client lama WT-only; client saat ini pakai
  //                             message:mark_read per-pesan di kedua jalur.
  //  - message:deleted        → WT-only; unsend di WSS lewat message:unsend.
  //  - migration:chunk/start/ack → WT-only (transfer vault device-to-device
  //                             butuh through-put stream; WSS fallback belum).
  const KNOWN_WT_ONLY = new Set([
    'message:ack_delivered',
    'messages:mark_as_read',
    'messages:mark_read',
    'messages:mark_delivered',
    'message:deleted',
    'migration:chunk',
    'migration:start',
    'migration:ack',
  ]);

  const handled = new Set(extractHandledKeySyncEvents(handlersSource));
  const wssEvents = new Set<string>(WSS_KEYS_SYNC_EVENTS);
  const gaps = handled.size > 0 ? [...handled].filter((e) => !wssEvents.has(e)) : [];

  const unexpected = gaps.filter((e) => !KNOWN_WT_ONLY.has(e));
  assert.deepEqual(
    unexpected,
    [],
    `case handleKeySync baru tanpa rute WSS & tanpa entri KNOWN_WT_ONLY: ${unexpected.join(', ')}`
  );
  // Gap yang tercantum harus benar-benar masih ada (jika suatu saat case-nya
  // hilang dari handler, daftar KNOWN_WT_ONLY ikut dibersihkan).
  const stale = [...KNOWN_WT_ONLY].filter((e) => !handled.has(e));
  assert.deepEqual(stale, [], 'KNOWN_WT_ONLY berisi case yang sudah tidak ada di handler');
});

test('gateway mendaftarkan event KEY_SYNC via loop atas WSS_KEYS_SYNC_EVENTS (sumber kebenaran tunggal)', () => {
  // Setelah refactor, KEY_SYNC didaftarkan dalam satu loop `for (const event of
  // WSS_KEYS_SYNC_EVENTS) socket.on(event, keySyncHandler(event))` — tidak ada
  // lagi registrasi literal satu per satu yang bisa menyimpang dari daftar.
  assert.match(
    gatewaySource,
    /for \(const event of WSS_KEYS_SYNC_EVENTS\)\s*\{?\s*socket\.on\(event, keySyncHandler\(event\)\)/,
    'gateway harus mendaftarkan KEY_SYNC via loop WSS_KEYS_SYNC_EVENTS (bukan manual)'
  );

  // Jalur fixed (non-KEY_SYNC) tetap dicek via socket.on literal.
  const socketEvents = extractGatewaySocketEvents(gatewaySource);
  for (const required of ['message:send', 'message:ack_delivered', 'presence:update']) {
    assert.ok(socketEvents.includes(required), `jalur fixed '${required}' harus terdaftar di gateway`);
  }
  // Tidak boleh ada registrasi literal KEY_SYNC tersisa (double-listen dengan loop).
  const duplicateLiteral = socketEvents.filter((e) => (WSS_KEYS_SYNC_EVENTS as readonly string[]).includes(e));
  assert.deepEqual(duplicateLiteral, [], 'registrasi literal KEY_SYNC ganda terdeteksi — hapus, gunakan loop');
});

test('gateway meneruskan msgId ke handleKeySync (paritas ACK dengan jalur WT)', () => {
  // keySyncHandler harus meneruskan msgId dari arg ke-2 emit socket.io.
  assert.match(
    gatewaySource,
    /keySyncHandler[\s\S]*?msgId:\s*typeof msgId === 'string'/,
    'gateway harus meneruskan msgId (arg ke-2) ke handleKeySync'
  );
  // Dan handleChatMessage juga (paritas ACK pesan).
  assert.match(gatewaySource, /handleChatMessage\(/);
  assert.match(gatewaySource, /typeof msgId === 'string' \? msgId : undefined/);
});
