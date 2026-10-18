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
import { CLIENT_CAPABILITIES, SERVER_CAPABILITIES } from '@nyx/shared';
import {
  negotiateWssCapabilities,
  parseAnnouncedCapabilities,
  recordWssCapabilities,
} from '../src/utils/transportCapability.js';
import { renderMetricsText, resetMetricsForTests } from '../src/utils/metrics.js';

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

/** Event yang didaftarkan di gateway (semua inbound) — termasuk via wrapper
 *  guardedOn (robustness: rejection handler async tak boleh crash proses). */
function extractGatewaySocketEvents(source: string): string[] {
  const events = new Set<string>();
  const re = /(?:socket\.on|guardedOn)\('([^']+)'/g;
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
  //  - message:deleted        → WT-only; unsend di WSS lewat message:unsend.
  //
  // `migration:chunk/start/ack` DULU ada di daftar ini ("WSS fallback belum"),
  // tetapi gateway sekarang meneruskannya (`WSS_KEYS_SYNC_EVENTS` memuatnya) dan
  // transfer perangkat lewat WSS sudah punya jalurnya. Entri lama dihapus supaya
  // daftar ini tetap berarti: apa pun yang tercantum = BENAR-BENAR belum ada
  // rutenya. Kalau salah satu event migration dicebut dari gateway tanpa sengaja,
  // test pertama di file ini gagal (`missing` tidak kosong) — bukan test ini.
  const KNOWN_WT_ONLY = new Set([
    'message:ack_delivered',
    'message:deleted',
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
  // KEY_SYNC didaftarkan dalam satu loop `for (const event of
  // WSS_KEYS_SYNC_EVENTS)` — registrasi bisa socket.on langsung atau wrapper
  // guardedOn (robustness), tapi TETAP satu loop dengan variabel event — tidak
  // ada registrasi literal satu per satu yang bisa menyimpang dari daftar.
  assert.match(
    gatewaySource,
    /for \(const event of WSS_KEYS_SYNC_EVENTS\)\s*\{?\s*(?:socket\.on|guardedOn)\(event, keySyncHandler\(event\)\)/,
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
  // [ROBUSTNESS] Jalur fixed & loop KEY_SYNC harus terdaftar via guardedOn
  // (guard rejection), bukan socket.on telanjang — regrese guard = crash proses.
  for (const guarded of ['message:send', 'message:ack_delivered', 'presence:update']) {
    assert.match(
      gatewaySource,
      new RegExp(`guardedOn\\('${guarded}'`),
      `'${guarded}' harus terdaftar via guardedOn (guard unhandledRejection)`
    );
  }
});

// ============================================================================
// [docs/29 §5.6 · docs/33 §33.7] Negosiasi kapabilitas jalur WSS
// ============================================================================
//
// Jalur WT menegosiasikan kapabilitas lewat HELLO bidi di sidecar; jalur WSS
// (fallback yang dipakai klien di jaringan yang memblokir QUIC) harus setara,
// karena tanpa itu `negotiatedCapabilities` selalu kosong di WSS dan jalur
// ratchet v2 (braid SPQR) tidak pernah dipakai walau kedua peer sudah saling
// menyatakan mampu in-band. Yang diuji di sini: logika murninya (bentuk input
// dari jaringan + irisan) dan jejaknya di metrik — bukan hanya wiring.

test('kapabilitas WSS: klien legacy (tanpa field) = daftar kosong, bukan error', () => {
  assert.deepEqual(parseAnnouncedCapabilities(undefined), []);
  assert.deepEqual(parseAnnouncedCapabilities(null), []);
  assert.deepEqual(parseAnnouncedCapabilities([]), []);
  assert.deepEqual(negotiateWssCapabilities(undefined), []);
});

test('kapabilitas WSS: bentuk cacat ditolak sebagai legacy (satu klien cacat tidak memutus handshake)', () => {
  // Payload ini datang dari klien mana pun → batasnya bagian kontrak.
  for (const bad of ['spqr-ratchet', 42, { caps: ['x'] }, [1], [''], ['a'.repeat(65)], Array(33).fill('c')]) {
    assert.deepEqual(parseAnnouncedCapabilities(bad), [], `bentuk cacat lolos: ${JSON.stringify(bad)}`);
  }
});

test('kapabilitas WSS: irisan dengan SERVER_CAPABILITIES (klien tak bisa mengaktifkan yang tak ada)', () => {
  assert.deepEqual(
    parseAnnouncedCapabilities(['hello-v1', CLIENT_CAPABILITIES.SPQR_RATCHET, 'hello-v1']),
    ['hello-v1', CLIENT_CAPABILITIES.SPQR_RATCHET],
    'duplikat dibuang, urutan klien dipertahankan'
  );
  assert.deepEqual(
    negotiateWssCapabilities(['kt-lite', CLIENT_CAPABILITIES.SPQR_RATCHET]),
    [CLIENT_CAPABILITIES.SPQR_RATCHET],
    'kapabilitas tak dikenal server tidak pernah masuk hasil'
  );
  // Sumber kebenaran tunggal untuk kedua relay: daftar yang disepakati selalu
  // subset `SERVER_CAPABILITIES` (sidecar Rust memakai konstanta yang sama).
  assert.deepEqual(negotiateWssCapabilities([...SERVER_CAPABILITIES]), [...SERVER_CAPABILITIES]);
  assert.deepEqual(negotiateWssCapabilities(['multi-device']), [], 'kapabilitas yang tidak ada tidak diiklankan');
});

test('kapabilitas WSS terlihat di metrik: per kapabilitas, dan "none" bila tak ada yang cocok', () => {
  resetMetricsForTests();
  recordWssCapabilities([]);
  recordWssCapabilities([CLIENT_CAPABILITIES.SPQR_RATCHET]);
  recordWssCapabilities([CLIENT_CAPABILITIES.HELLO_V1, CLIENT_CAPABILITIES.SPQR_RATCHET]);

  const text = renderMetricsText();
  const value = (capability: string): number => {
    const match = text.match(new RegExp(`nyx_wss_capability_total\\{capability="${capability}"\\} (\\d+)`));
    return match ? Number.parseInt(match[1]!, 10) : 0;
  };
  assert.equal(value('none'), 1, 'koneksi tanpa kapabilitas yang cocok tercatat sebagai none');
  assert.equal(value(CLIENT_CAPABILITIES.SPQR_RATCHET), 2, 'rollout spqr-ratchet harus terukur');
  assert.equal(value(CLIENT_CAPABILITIES.HELLO_V1), 1);
  resetMetricsForTests();
});

test('gateway WSS membalas kapabilitas hasil irisan (paritas dengan HELLO sidecar)', () => {
  // Wiring diperiksa dari source: balasan hanya untuk klien yang mengiklankan,
  // dan irisan dihitung helper yang sama (tidak ada daftar kapabilitas lokal).
  assert.match(gatewaySource, /socket\.emit\('capabilities', agreed\)/);
  assert.match(gatewaySource, /if \(announced\.length > 0\)/);
  assert.match(gatewaySource, /recordWssCapabilities\(agreed\)/);
  assert.doesNotMatch(gatewaySource, /'spqr-ratchet'/, 'nama kapabilitas hidup di @nyx/shared');
});

// ============================================================================
// [PARITY 2026-10-18] Gap yang ditemukan saat audit jalur WT ↔ WSS
// ============================================================================
//
// Tiga kelas gap (rate limit hanya di WSS, sinyal WebRTC hilang di WSS, dan
// bucket presence beda angka) sudah diperbaiki. Test di bawah mengunci perbaikan
// itu supaya tidak kembali secara diam-diam.

test('rate limit jalur data hidup di HANDLER, bukan di gateway (satu hitungan untuk dua transport)', () => {
  // Kalau bucket dipasang di DUA tempat, klien WSS menghitung ganda (limit
  // efektif separuh) — dan klien WT tetap tak terlindungi.
  for (const bucket of ['chat_message', 'message_ack_delivered', 'presence_update']) {
    assert.doesNotMatch(
      gatewaySource,
      new RegExp(`checkRateLimit\\(userId, '${bucket}'`),
      `bucket '${bucket}' harus dipasang di realtimeHandlers, bukan gateway`
    );
  }

  const expectations: Array<[string, string]> = [
    ['chat_message', 'CHAT_RATE_LIMIT'],
    ['message_ack_delivered', 'ACK_RATE_LIMIT'],
    ['presence_update', 'PRESENCE_RATE_LIMIT'],
  ];
  for (const [bucket, constName] of expectations) {
    assert.match(
      handlersSource,
      new RegExp(`checkRateLimit\\(userId, '${bucket}', ${constName}\\.limit, ${constName}\\.windowSeconds\\)`),
      `handler harus menegakkan bucket '${bucket}' untuk KEDUA transport`
    );
  }
  // Angka bucket dikunci sekali di sini (nilai efektifnya juga diuji perilaku
  // di realtimeHandlers.test.ts).
  assert.match(handlersSource, /CHAT_RATE_LIMIT = \{ limit: 120, windowSeconds: 60 \} as const/);
  assert.match(handlersSource, /ACK_RATE_LIMIT = \{ limit: 240, windowSeconds: 60 \} as const/);
  assert.match(handlersSource, /PRESENCE_RATE_LIMIT = \{ limit: 30, windowSeconds: 60 \} as const/);
});

test('gateway WSS merutekan sinyal WebRTC dua arah (paritas opcode 0x03/0x04)', () => {
  // Masuk: klien WSS mengirim event yang sama dengan yang dipakai di shared
  // socket contract; keluar: envelope relay dipetakan ke event itu, BUKAN
  // jatuh ke cabang default (`message:new`).
  assert.match(gatewaySource, /guardedOn\('webrtc:secure_signal'/, 'sinyal masuk harus terdaftar di gateway');
  assert.match(gatewaySource, /handleWebRtcRelay\(/, 'gateway harus memakai handler relay bersama');
  assert.match(
    gatewaySource,
    /case TransportOpCode\.WEBRTC_SIGNAL:\s*\n\s*case TransportOpCode\.WEBRTC_ICE:/,
    'kedua opcode sinyal harus punya cabang keluar'
  );
  assert.match(
    gatewaySource,
    /sock\.emit\('webrtc:secure_signal', json\)/,
    'sinyal keluar harus dipetakan ke webrtc:secure_signal (bukan message:new)'
  );
  // Satu sumber logika relay untuk kedua transport, memakai ctx (bisa diuji
  // tanpa Redis nyata) — bukan client global seperti sebelumnya.
  assert.match(handlersSource, /export async function handleWebRtcRelay\(/);
  assert.match(handlersSource, /relayCallSignal\(ctx\.redisClient/);
  assert.doesNotMatch(handlersSource, /relayCallSignal\(redisClient/);
});

test('gateway memakai event `penghentian sesi` yang sama dengan jalur WT (force_logout via KICK)', () => {
  // Jalur WT sekarang mengirim frame KICK sebelum menutup koneksi (sidecar),
  // dan klien memetakan payload-nya ke `force_logout` device-scoped — sama
  // seperti gateway. Kontrak event-nya karena itu tidak boleh berubah di sini.
  assert.match(gatewaySource, /case TransportOpCode\.KICK:[\s\S]{0,80}sock\.emit\('force_logout', json\)/);
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
