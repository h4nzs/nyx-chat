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
 * [D6 2026-10-27] Dulu hampir semua uji di file ini mencocokkan TEKS SUMBER
 * gateway/handler. Itu salah alat: refactor yang setara (memindahkan empat
 * handler tetap ke tabel) memerahkan test tanpa ada perilaku yang berubah,
 * sementara perubahan perilaku lolos selama potongan teks yang dicari masih ada.
 * Sekarang yang diuji adalah **data & fungsi yang benar-benar dipakai** runtime:
 *
 *   - `wssInboundTable()`  → daftar registrasi inbound gateway (dipakai loop
 *                            `attachWssGateway`), termasuk jenis dispatch-nya.
 *   - `wssDownstreamRoute()` → pemetaan opcode → event socket.io + payload,
 *                            tempat bug "sinyal WebRTC terkirim sebagai
 *                            message:new" dulu hidup.
 *
 * Yang **tetap** membaca sumber hanya dua kelas invariant yang tidak bisa
 * diamati dari perilaku tanpa menyalakan server socket.io + Redis:
 *   1. inventaris `case` di `handleKeySync` (switch, bukan data);
 *   2. tidak adanya bucket rate-limit di gateway (properti *absen*; kehadirannya
 *      hanya bisa dibuktikan dengan dua klien nyata).
 * Keduanya diberi komentar eksplisit supaya tidak dipakai sebagai pola umum.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createHandlerFailureReporter,
  makeGuardedOn,
  WSS_FIXED_EVENTS,
  WSS_KEYS_SYNC_EVENTS,
  wssDownstreamRoute,
  wssInboundTable,
} from '../src/realtime/gateway.js';
import { CLIENT_CAPABILITIES, SERVER_CAPABILITIES } from '@nyx/shared';
import {
  negotiateWssCapabilities,
  parseAnnouncedCapabilities,
  recordWssCapabilities,
} from '../src/utils/transportCapability.js';
import { renderMetricsText, resetMetricsForTests } from '../src/utils/metrics.js';
import { TransportOpCode } from '@nyx/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const handlersSource = readFileSync(
  path.join(here, '../src/network/realtimeHandlers.ts'),
  'utf8'
);
const gatewaySource = readFileSync(
  path.join(here, '../src/realtime/gateway.ts'),
  'utf8'
);

/** Case di dalam switch(event) handleKeySync. [statis — lihat header file] */
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

test('WSS_KEYS_SYNC_EVENTS non-kosong dan unik', () => {
  assert.ok(WSS_KEYS_SYNC_EVENTS.length >= 20, 'minimal 20 event KEY_SYNC');
  assert.equal(new Set(WSS_KEYS_SYNC_EVENTS).size, WSS_KEYS_SYNC_EVENTS.length, 'tidak ada duplikat');
});

test('tabel inbound = jalur tetap + seluruh KEY_SYNC, tanpa duplikat', () => {
  const table = wssInboundTable();
  const events = table.map((entry) => entry.event);

  assert.deepEqual(
    events,
    [...WSS_FIXED_EVENTS, ...WSS_KEYS_SYNC_EVENTS],
    'urutan & isi registrasi harus persis jalur tetap lalu KEY_SYNC'
  );
  assert.equal(new Set(events).size, events.length, 'registrasi ganda = handler berjalan dua kali');

  // Jenis dispatch menempel pada event yang benar — bukan hanya nama yang ada.
  const kindOf = (event: string) => table.find((entry) => entry.event === event)?.kind;
  assert.equal(kindOf('message:send'), 'chat');
  assert.equal(kindOf('message:ack_delivered'), 'ack');
  assert.equal(kindOf('presence:update'), 'presence');
  assert.equal(kindOf('webrtc:secure_signal'), 'webrtc');
  for (const event of WSS_KEYS_SYNC_EVENTS) {
    assert.equal(kindOf(event), 'keysync', `${event} harus diteruskan ke handleKeySync`);
  }
});

test('setiap event gateway WSS punya case di handleKeySync (tidak ada event basi/typo)', () => {
  // [statis] Inventaris `case` hidup di dalam switch, bukan data yang bisa
  // dibaca runtime. Yang menjaganya tetap benar adalah test ini: event yang
  // didaftarkan gateway tapi tidak ditangani handler adalah pintu kosong.
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

// ============================================================================
// [D6] Pemetaan envelope downstream → event socket.io (perilaku, bukan teks)
// ============================================================================
//
// Inilah bug paritas yang ditemukan 2026-10-18: sinyal WebRTC tidak punya field
// `event`, jadi cabang default mengirimnya sebagai `message:new` dan klien
// membuangnya. Uji di bawah memanggil fungsi yang sama dengan yang dipakai
// `deliver()` di gateway, untuk setiap opcode — termasuk payload yang dikirim.

test('routing downstream: setiap opcode dipetakan ke event yang benar', () => {
  const json = { from: 'peer', type: 'offer', payload: 'x' };

  assert.deepEqual(wssDownstreamRoute(TransportOpCode.CHAT_MESSAGE, json), {
    event: 'message:new',
    payload: json,
  });
  assert.deepEqual(wssDownstreamRoute(TransportOpCode.PRESENCE, json), {
    event: 'presence:update',
    payload: json,
  });
  assert.deepEqual(wssDownstreamRoute(TransportOpCode.KICK, json), {
    event: 'force_logout',
    payload: json,
  });
  assert.deepEqual(wssDownstreamRoute(TransportOpCode.ACK, { msgId: 'm1', data: { ok: true } }), {
    event: 'message:ack_delivered',
    payload: { msgId: 'm1', data: { ok: true } },
  });

  // Sinyal panggilan TIDAK boleh jatuh ke message:new (bug yang diperbaiki).
  for (const opCode of [TransportOpCode.WEBRTC_SIGNAL, TransportOpCode.WEBRTC_ICE]) {
    const route = wssDownstreamRoute(opCode, json);
    assert.equal(route.event, 'webrtc:secure_signal');
    assert.notEqual(route.event, 'message:new', 'sinyal WebRTC tidak boleh dikirim sebagai pesan chat');
    assert.equal(route.payload, json, 'envelope relay diteruskan utuh');
  }
});

test('routing downstream: KEY_SYNC memakai event dari payload dan mengirim `data` saja', () => {
  // Paritas jalur WT: klien menerima { event, data } → socket.io meng-emit
  // nama event dengan `data` sebagai argumen (bukan seluruh envelope).
  const keySync = TransportOpCode.KEY_SYNC;
  const markRead = { event: 'message:mark_read', data: { messageId: 'm1' } };
  assert.deepEqual(wssDownstreamRoute(keySync, markRead), {
    event: 'message:mark_read',
    payload: { messageId: 'm1' },
  });

  // Envelope cacat tetap punya tujuan yang aman, bukan melempar.
  assert.deepEqual(wssDownstreamRoute(keySync, {}), { event: 'message:new', payload: undefined });
  assert.deepEqual(wssDownstreamRoute(keySync, { event: 42, data: 'x' }), {
    event: 'message:new',
    payload: 'x',
  });
  assert.deepEqual(wssDownstreamRoute(keySync, { event: '', data: 'x' }), {
    event: 'message:new',
    payload: 'x',
  });
});

// ============================================================================
// [D6] Guard handler: rejection tidak boleh membunuh proses
// ============================================================================
//
// Wrapper ini dulu hidup di dalam closure `io.on('connection')`, sehingga satu-
// satunya cara menguji regresinya adalah mencocokkan teks `guardedOn('…'` di
// sumber. Sekarang wrapper-nya fungsi murni atas objek mirip-socket: perilaku
// yang menentukan (rejection ditangkap, callback dibalas, koneksi diputus) bisa
// dijalankan langsung tanpa satu pun server/klien nyata.

test('guard: handler yang melempar tidak lolos sebagai unhandledRejection, koneksi diputus', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let disconnects = 0;
  const fakeSocket = {
    on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); },
    disconnect() { disconnects += 1; },
  };
  // Reporter yang SAMA dengan yang dipakai `attachWssGateway`.
  const guardedOn = makeGuardedOn(
    fakeSocket as never,
    createHandlerFailureReporter(fakeSocket as never, 'u1')
  );

  const replies: unknown[] = [];
  guardedOn('message:send', async () => { throw new Error('boom'); });
  const listener = listeners.get('message:send');
  assert.ok(listener, 'handler harus terdaftar');
  listener({ payload: 1 }, (reply: unknown) => replies.push(reply));

  // Beri satu putaran event loop supaya catch di wrapper berjalan; kalau
  // rejection-nya lolos, node:test melaporkannya sebagai unhandled rejection.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(disconnects, 1, 'sesi bermasalah direset, proses tetap hidup');
  assert.deepEqual(replies, [{ ok: false, error: 'INTERNAL_ERROR' }], 'callback klien dijawab, tidak menggantung');
});

test('guard: handler yang berhasil tidak memutus koneksi dan tidak membalas apa pun', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let disconnects = 0;
  const guardedOn = makeGuardedOn(
    { on(event, listener) { listeners.set(event, listener); }, disconnect() { disconnects += 1; } } as never,
    () => { throw new Error('seharusnya tidak dipanggil'); }
  );

  const seen: unknown[][] = [];
  guardedOn('presence:update', async (...args) => { seen.push(args); });
  listeners.get('presence:update')!({ event: 'typing:start' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(seen, [[{ event: 'typing:start' }]], 'argumen diteruskan apa adanya');
  assert.equal(disconnects, 0);
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

test('gateway hanya mengiklankan kapabilitas lewat helper bersama (tanpa daftar lokal)', () => {
  // [statis] Wiring handshake: balasan hanya untuk klien yang mengiklankan, dan
  // hasilnya dihitung helper yang sama. Menguji ini butuh socket.io + auth
  // nyata; yang bisa dipastikan tanpa itu adalah tidak ada nama kapabilitas
  // literal di gateway (sumber kebenaran tunggal di @nyx/shared).
  assert.doesNotMatch(gatewaySource, /'spqr-ratchet'/, 'nama kapabilitas hidup di @nyx/shared');
  assert.doesNotMatch(gatewaySource, /negotiateWssCapabilities\(\[/, 'irisan dihitung helper, bukan daftar lokal');
});

// ============================================================================
// [PARITY 2026-10-18] Gap yang ditemukan saat audit jalur WT ↔ WSS
// ============================================================================
//
// Tiga kelas gap (rate limit hanya di WSS, sinyal WebRTC hilang di WSS, dan
// bucket presence beda angka) sudah diperbaiki. Efek perilakunya dikunci di
// `realtimeHandlers.test.ts` (bucket + angka efektif per handler); yang tersisa
// di sini hanya properti yang tidak bisa diamati dari perilaku tanpa dua klien.

test('rate limit jalur data hidup di HANDLER, bukan di gateway (satu hitungan untuk dua transport)', () => {
  // [statis — properti ABSEN] Kehadiran bucket di gateway akan menghitung ganda
  // untuk klien WSS; tidak adanya panggilan hanya bisa dibuktikan dari sumber
  // (mengujinya perilaku butuh dua koneksi socket.io + Redis). Angka efektif
  // tiap bucket diuji perilaku di realtimeHandlers.test.ts ("PARITY: …").
  for (const bucket of ['chat_message', 'message_ack_delivered', 'presence_update']) {
    assert.doesNotMatch(
      gatewaySource,
      new RegExp(`checkRateLimit\\(userId, '${bucket}'`),
      `bucket '${bucket}' harus dipasang di realtimeHandlers, bukan gateway`
    );
  }
  // Jalur tetap tetap memakai guard yang sama untuk perangkat.
  assert.match(gatewaySource, /isActiveDeviceAllowed\(userId, deviceId\)/, 'gateway tetap memeriksa perangkat aktif');
});

test('gateway meneruskan msgId ke handler (paritas ACK dengan jalur WT)', () => {
  // [statis] Nilai yang diteruskan adalah argumen socket.io ke-2; membuktikannya
  // butuh klien nyata. Bentuknya dikunci di sini supaya tidak hilang diam-diam.
  assert.match(
    gatewaySource,
    /msgId: typeof msgId === 'string' \? msgId : ''/,
    'gateway harus meneruskan msgId (arg ke-2) ke handleKeySync'
  );
  assert.match(gatewaySource, /typeof msgId === 'string' \? msgId : undefined/);
});
