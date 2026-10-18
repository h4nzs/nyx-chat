// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §5.6] Negosiasi kapabilitas transport — kontrak + paritas.
 *
 * Yang diuji:
 *   1. Wire format HELLO/ACK (JSON `{v,caps}`) beserta penolakan bentuk tak sah
 *      (payload ini datang dari jaringan, jadi batas anti-DoS-nya bagian kontrak).
 *   2. Semantik irisan kapabilitas (deterministik, tak dikenal tidak masuk).
 *   3. PARITAS lintas-implementasi: konstanta di sidecar Rust harus sama dengan
 *      `@nyx/shared` (opcode 0x0B, versi 1, nama kapabilitas, batas parse).
 *      Dua implementasi yang menyimpang = klien & server saling tidak paham.
 *   4. Wiring: klien mengirim HELLO saat konek WT, punya fallback legacy saat
 *      tidak dijawab, dan HELLO tidak pernah di-map ke event socket.io.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CLIENT_CAPABILITIES,
  HELLO_MAX_CAPS,
  HELLO_MAX_CAP_LENGTH,
  SERVER_CAPABILITIES,
  TRANSPORT_PROTOCOL_VERSION,
  TransportOpCode,
  encodeTransportHello,
  negotiateCapabilities,
  parseTransportHello,
  sanitizeCapabilityList,
  supportsCapability,
} from '@nyx/shared';

const repoFile = (p: string) => readFileSync(resolve(process.cwd(), '..', p), 'utf8');
const webFile = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('kontrak HELLO/ACK', () => {
  it('encode → parse round-trip, cap duplikat dibuang', () => {
    const bytes = encodeTransportHello({ v: TRANSPORT_PROTOCOL_VERSION, caps: ['hello-v1', 'hello-v1'] });
    const parsed = parseTransportHello(bytes);
    expect(parsed).toEqual({ v: 1, caps: ['hello-v1'] });
    expect(parseTransportHello(new TextDecoder().decode(bytes))).toEqual(parsed);
  });

  it('menolak payload tak sah (payload jaringan = permukaan serangan)', () => {
    expect(parseTransportHello('')).toBeNull();
    expect(parseTransportHello('bukan-json')).toBeNull();
    expect(parseTransportHello('[1,2,3]')).toBeNull();
    expect(parseTransportHello('null')).toBeNull();
    expect(parseTransportHello({ v: 0, caps: [] } as unknown as string)).toBeNull();
    expect(parseTransportHello(JSON.stringify({ v: 0, caps: [] }))).toBeNull();
    expect(parseTransportHello(JSON.stringify({ v: 1.5, caps: [] }))).toBeNull();
    expect(parseTransportHello(JSON.stringify({ v: 70000, caps: [] }))).toBeNull();
    expect(parseTransportHello(JSON.stringify({ v: 1, caps: 'hello' }))).toBeNull();
    expect(parseTransportHello(JSON.stringify({ v: 1, caps: [''] }))).toBeNull();
    expect(parseTransportHello(JSON.stringify({ v: 1, caps: ['a'.repeat(HELLO_MAX_CAP_LENGTH + 1)] }))).toBeNull();
    expect(parseTransportHello(JSON.stringify({ v: 1, caps: Array(HELLO_MAX_CAPS + 1).fill('c') }))).toBeNull();
    // Payload kelewat besar ditolak sebelum JSON.parse.
    expect(parseTransportHello(new Uint8Array(5000))).toBeNull();
  });

  it('sanitize daftar kapabilitas jaringan (jalur WT HELLO dan WSS handshake)', () => {
    // Bentuk sah: duplikat dibuang, urutan dipertahankan, array kosong valid.
    expect(sanitizeCapabilityList(['hello-v1', 'spqr-ratchet', 'hello-v1'])).toEqual([
      'hello-v1',
      'spqr-ratchet',
    ]);
    expect(sanitizeCapabilityList([])).toEqual([]);

    // Bentuk tak sah → null (pemanggil memperlakukannya legacy, bukan error).
    expect(sanitizeCapabilityList(undefined)).toBeNull();
    expect(sanitizeCapabilityList(null)).toBeNull();
    expect(sanitizeCapabilityList('hello-v1')).toBeNull();
    expect(sanitizeCapabilityList({ caps: ['hello-v1'] })).toBeNull();
    expect(sanitizeCapabilityList([1, 2])).toBeNull();
    expect(sanitizeCapabilityList([''])).toBeNull();
    expect(sanitizeCapabilityList(['a'.repeat(HELLO_MAX_CAP_LENGTH + 1)])).toBeNull();
    expect(sanitizeCapabilityList(Array(HELLO_MAX_CAPS + 1).fill('c'))).toBeNull();
  });

  it('parseTransportHello memakai sanitize yang sama (satu batas, dua jalur)', () => {
    // Regresi: batas parse tidak boleh disalin ulang di parser (dua implementasi
    // = dua batas yang bisa menyimpang).
    expect(parseTransportHello(JSON.stringify({ v: 1, caps: Array(HELLO_MAX_CAPS + 1).fill('c') }))).toBeNull();
    expect(parseTransportHello(JSON.stringify({ v: 1, caps: ['ok', 'ok'] }))).toEqual({
      v: 1,
      caps: ['ok'],
    });
  });

  it('irisan kapabilitas: deterministik, urut klien, tak dikenal tidak masuk', () => {
    expect(negotiateCapabilities(['kt-lite', 'hello-v1'], ['hello-v1', 'kt-lite'])).toEqual(['kt-lite', 'hello-v1']);
    expect(negotiateCapabilities(['experimental', 'hello-v1'], ['hello-v1'])).toEqual(['hello-v1']);
    expect(negotiateCapabilities([], ['hello-v1'])).toEqual([]);
    expect(negotiateCapabilities(['hello-v1'], [])).toEqual([]);
    expect(supportsCapability(['hello-v1'], CLIENT_CAPABILITIES.HELLO_V1)).toBe(true);
    expect(supportsCapability(undefined, CLIENT_CAPABILITIES.HELLO_V1)).toBe(false);
  });

  it('opcode HELLO tidak bertabrakan dengan opcode yang sudah dipakai', () => {
    expect(TransportOpCode.HELLO).toBe(0x0b);
    const used = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0a];
    expect(used).not.toContain(TransportOpCode.HELLO);
  });
});

describe('paritas sidecar Rust ↔ @nyx/shared', () => {
  // [docs/30 WS-G(5)] Keputusan protokol murni pindah ke crate lib
  // (`protocol.rs`); `main.rs` tinggal I/O dan memanggil parser bersama.
  const rust = repoFile('server/transport-sidecar/src/protocol.rs');
  const main = repoFile('server/transport-sidecar/src/main.rs');

  it('konstanta numerik & string identik', () => {
    expect(rust).toMatch(/pub const HELLO_OPCODE: u8 = 0x0B;/);
    expect(rust).toMatch(new RegExp(`pub const TRANSPORT_PROTOCOL_VERSION: u32 = ${TRANSPORT_PROTOCOL_VERSION};`));
    expect(rust).toMatch(new RegExp(`pub const HELLO_MAX_CAPS: usize = ${HELLO_MAX_CAPS};`));
    expect(rust).toMatch(new RegExp(`pub const HELLO_MAX_CAP_LENGTH: usize = ${HELLO_MAX_CAP_LENGTH};`));
    for (const cap of SERVER_CAPABILITIES) {
      expect(rust).toContain(`"${cap}"`);
    }
  });

  it('balasan memakai opcode HELLO (0x0B), bukan ACK (0x06)', () => {
    expect(rust).toMatch(/fn hello_reply_frame[\s\S]{0,200}frame\.push\(HELLO_OPCODE\)/);
  });

  it('HELLO adalah transport-local: dijawab jalur bidi SEBELUM publish upstream', () => {
    // Di jalur bidi, cabang HELLO harus muncul sebelum publish dan memakai
    // `hello_reply_frame` (bukan meneruskan payload ke Redis/Node).
    const helloIdx = main.indexOf('InboundHeader::Hello');
    const replyIdx = main.indexOf('hello_reply_frame');
    const publishIdx = main.indexOf('let channel = format!("nyx:upstream:{}", op_code);');
    expect(helloIdx).toBeGreaterThan(-1);
    expect(replyIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(-1);
    expect(helloIdx).toBeLessThan(publishIdx);
    expect(replyIdx).toBeLessThan(publishIdx);
  });

  it('SEMUA jalur relay memakai parser bersama — tidak ada guard opcode yang disalin ulang', () => {
    // bidi: klasifikasi header; uni + datagram: parse buffer utuh.
    const classify = [...main.matchAll(/classify_inbound\(/g)];
    const parse = [...main.matchAll(/parse_inbound_frame\(/g)];
    expect(classify.length).toBeGreaterThanOrEqual(1);
    expect(parse.length).toBeGreaterThanOrEqual(2);
    // Jalur uni & datagram wajib menangani HELLO dari parser (tidak meneruskan).
    expect([...main.matchAll(/InboundFrame::Hello\(_\)/g)]).toHaveLength(2);
    // Regresi yang dijaga: logika framing tidak boleh disalin ulang inline.
    expect(main).not.toMatch(/if op_code == HELLO_OPCODE/);
    expect(main).not.toMatch(/if op_code == 0x00/);
    // Batas 32 KB juga tidak boleh jadi angka ajaib di call site.
    expect(main).not.toMatch(/32768/);
    expect(main).toMatch(/classify_inbound\(op_code, length, MAX_BIDI_PAYLOAD_BYTES\)/);
  });

  it('parser murni menjaga opcode transport-local (CHAFF/HELLO) tetap lokal', () => {
    // Invariant yang sama dikunci sebagai perilaku di `cargo test`
    // (protocol::tests + fuzz::tests); di sini yang dijaga adalah wiring-nya.
    expect(rust).toMatch(/pub const CHAFF_OPCODE: u8 = 0x00;/);
    expect(rust).toMatch(/match classify_inbound\(op_code, length, max_payload\)/);
    expect(rust).toMatch(/if op_code == HELLO_OPCODE {\s*InboundFrame::Hello\(payload\)/);
  });
});

describe('wiring klien', () => {
  const client = webFile('src/lib/transportClient.ts');
  const worker = webFile('src/workers/transport.worker.ts');
  const sharedTransport = repoFile('packages/shared/src/transport.ts');

  it('mengirim HELLO saat koneksi WT dan punya fallback legacy', () => {
    expect(client).toMatch(/sendCapabilityHello\(\)/);
    expect(client).toMatch(/encodeTransportHello\(\{ v: TRANSPORT_PROTOCOL_VERSION, caps: ANNOUNCED_CLIENT_CAPABILITIES \}\)/);
    expect(client).toMatch(/HELLO_ACK_TIMEOUT_MS/);
    expect(client).toMatch(/mode legacy \(tanpa kapabilitas\)/);
    expect(client).toMatch(/case TransportOpCode\.HELLO:/);
  });

  it('HELLO lewat stream BIDI (uni = tak bisa dibalas & bocor ke Redis)', () => {
    // Klien: TIDAK boleh memakai sendStream (uni-directional) untuk HELLO.
    expect(client).not.toMatch(/sendStream\(\s*TransportOpCode\.HELLO/);
    expect(client).toMatch(/type: 'CAPABILITY_HELLO'/);
    expect(sharedTransport).toMatch(/\| \{ type: 'CAPABILITY_HELLO'; payload: BinaryPayload \}/);

    // Worker: bidi stream, kirim frame HELLO, lalu teruskan balasan sebagai
    // DATA_RECEIVED (opcode dibaca dari frame balasan, bukan di-hardcode).
    const branch = worker.slice(worker.indexOf("case 'CAPABILITY_HELLO':"));
    const nextCase = branch.indexOf("case 'START_HANDSHAKE':");
    expect(nextCase).toBeGreaterThan(-1);
    const helloBranch = branch.slice(0, nextCase);
    expect(helloBranch).toMatch(/createBidirectionalStream\(\)/);
    expect(helloBranch).not.toMatch(/createUnidirectionalStream\(\)/);
    expect(helloBranch).toMatch(/frame\[0\] = TransportOpCode\.HELLO/);
    expect(helloBranch).toMatch(/type: 'DATA_RECEIVED'/);
  });

  it('hanya mengiklankan kapabilitas yang benar-benar siap', () => {
    const announced = client.match(/const ANNOUNCED_CLIENT_CAPABILITIES[^=]*= \[([^\]]*)\]/)?.[1] ?? '';
    expect(announced).toContain('CLIENT_CAPABILITIES.HELLO_V1');
    // [docs/33 §33.7] `spqr-ratchet` kini benar-benar ada implementasinya
    // (jalur v2 landed), tapi TIDAK boleh di-hardcode di klien: ia harus lewat
    // `advertisedCapabilities()` supaya kill switch `VITE_SPQR_FORCE_V1`
    // benar-benar mematikan iklannya.
    expect(announced).toContain('advertisedCapabilities()');
    expect(announced).not.toContain('CLIENT_CAPABILITIES.SPQR_RATCHET');
    // Fitur yang belum ada TIDAK boleh diiklankan (server bisa memilih format).
    for (const notReady of ['KT_LITE']) {
      expect(announced).not.toContain(`CLIENT_CAPABILITIES.${notReady}`);
    }
    // Multi-device dibatalkan sebagai non-goal (docs/30 §30.6/§30.18):
    // kapabilitasnya tidak boleh ada, apalagi diiklankan. Diperiksa pada nilai
    // runtime (bukan teks source) supaya komentar yang menjelaskan keputusan
    // tidak ikut dianggap pelanggaran.
    expect(Object.keys(CLIENT_CAPABILITIES)).not.toContain('MULTI_DEVICE');
    expect(Object.values(CLIENT_CAPABILITIES)).not.toContain('multi-device');
    expect(announced).not.toContain('multi-device');
  });

  it('jalur WSS (socket.io) tidak menggantung: HELLO di-map noop', () => {
    const mode = webFile('src/lib/transportMode.ts');
    expect(mode).toMatch(/\[TransportOpCode\.HELLO\]: \{ kind: 'noop' \}/);
    expect(client).toMatch(/resetCapabilityState\(true\)/);
  });

  it('[docs/33 §33.7] jalur WSS menegosiasikan kapabilitas — bukan lagi selalu legacy', () => {
    // Klien mengiklankan kapabilitas di handshake socket.io…
    expect(client).toMatch(/auth: \{ capabilities: ANNOUNCED_CLIENT_CAPABILITIES \}/);
    // …menunggu balasan gateway (`capabilities`) dan bisa jatuh ke legacy
    // (server lama) — dua jalur, satu cara menutup negosiasi.
    expect(client).toMatch(/socket\.on\('capabilities'/);
    expect(client).toMatch(/startWssCapabilityNegotiation\(\)/);
    expect(client).toMatch(/Gateway WSS tidak membalas kapabilitas/);
    expect(client).toMatch(/finishCapabilityNegotiation\([^)]*'wss'\)/);
    // Balasan kapabilitas BUKAN data pesan: tidak boleh di-map ke TransportEvents.
    expect(client).toMatch(/if \(eventName === 'capabilities'\) return;/);
    // Irisan dilakukan di klien juga (server tidak boleh mengaktifkan kapabilitas
    // yang tidak kita iklankan) — pakai helper bersama, bukan logika lokal.
    expect(client).toMatch(/negotiateCapabilities\(ANNOUNCED_CLIENT_CAPABILITIES, parsed\)/);
    expect(client).toMatch(/sanitizeCapabilityList\(caps\)/);
    // Satu tempat yang menutup negosiasi untuk KEDUA transport.
    expect(client).toMatch(/private finishCapabilityNegotiation\(agreed: string\[\], source: 'wt' \| 'wss'\)/);
  });

  it('[docs/29 §5.6] gateway WSS memakai helper negosiasi yang sama dengan aturan relay', () => {
    const gateway = repoFile('server/src/realtime/gateway.ts');
    const helper = repoFile('server/src/utils/transportCapability.ts');

    // Helper: satu sumber untuk parse + irisan, memakai konstanta @nyx/shared
    // (bukan daftar kapabilitas yang disalin ulang di server).
    expect(helper).toContain('sanitizeCapabilityList');
    expect(helper).toMatch(/negotiateCapabilities\(parseAnnouncedCapabilities\(raw\), SERVER_CAPABILITIES\)/);

    // Gateway: kapabilitas dibaca di handshake (auth), TIDAK pernah menggagalkan
    // koneksi (klien lama harus tetap bisa konek), lalu dibalas sebagai irisan.
    expect(gateway).toMatch(/socket\.handshake\.auth\?\.capabilities/);
    expect(gateway).toMatch(/socket\.emit\('capabilities', agreed\)/);
    expect(gateway).toMatch(/negotiateWssCapabilities\(announced\)/);
    // Balasan hanya untuk klien yang mengiklankan: klien lama tidak kenal event ini.
    expect(gateway).toMatch(/if \(announced\.length > 0\)/);
    // Tidak ada jalur yang memutus koneksi karena kapabilitas cacat.
    const useBlock = gateway.slice(gateway.indexOf('io.use((socket, next)'), gateway.indexOf("io.on('connection'"));
    expect(useBlock).not.toMatch(/capabilit[\s\S]{0,40}next\(new Error/);
  });

  it('kapabilitas WSS terlihat di metrik (rollout v2 bisa diukur, bukan ditebak)', () => {
    const metrics = repoFile('server/src/utils/metrics.ts');
    const helper = repoFile('server/src/utils/transportCapability.ts');
    expect(metrics).toMatch(/defineCounter\(\s*'nyx_wss_capability_total'/);
    expect(metrics).toContain("['capability']");
    expect(helper).toMatch(/incCounter\(WSS_CAPABILITY, \{ capability \}\)/);
    // Klien yang mengiklankan sesuatu yang tak dikenal tetap terlihat.
    expect(helper).toMatch(/capability: 'none'/);
  });
});

// ============================================================================
// [PARITY 2026-10-18] Wiring gap WT ↔ WSS yang diperbaiki saat audit
// ============================================================================
describe('paritas jalur WT ↔ WSS (audit 2026-10-18)', () => {
  const client = webFile('src/lib/transportClient.ts');
  const mode = webFile('src/lib/transportMode.ts');
  const gateway = repoFile('server/src/realtime/gateway.ts');
  const sidecar = repoFile('server/transport-sidecar/src/main.rs');

  it('sinyal panggilan (WEBRTC_SIGNAL/ICE) punya rute di KEDUA jalur', () => {
    // Keluar (klien WSS): tabel opcode → event, bukan noop (dulu hilang diam-diam).
    expect(mode).toMatch(/\[TransportOpCode\.WEBRTC_SIGNAL\]: \{ kind: 'fixed', event: 'webrtc:secure_signal' \}/);
    expect(mode).toMatch(/\[TransportOpCode\.WEBRTC_ICE\]: \{ kind: 'fixed', event: 'webrtc:secure_signal' \}/);
    // Masuk (klien WSS): envelope relay di-re-encode lalu lewat routeOpCode yang
    // sama dengan jalur WT → listener `webrtc:signal` tidak tahu transportnya.
    expect(client).toMatch(/eventName === 'webrtc:secure_signal'/);
    expect(client).toMatch(/routeOpCode\(TransportOpCode\.WEBRTC_SIGNAL, this\.encodeJson\(data\)\)/);
    // Server: gateway mendaftarkan event masuk DAN memetakan opcode keluar.
    expect(gateway).toMatch(/guardedOn\('webrtc:secure_signal'/);
    expect(gateway).toMatch(/sock\.emit\('webrtc:secure_signal', json\)/);
  });

  it('KICK di jalur WT: sidecar mengirim frame DULU, klien memetakannya seperti WSS', () => {
    // Sidecar: frame 0x07 ditulis sebelum koneksi ditutup (dulu hanya close).
    expect(sidecar).toMatch(/frame\.put_u8\(0x07\)/);
    expect(sidecar).toMatch(/let _ = stream\.finish\(\)\.await;[\s\S]{0,120}conn_kick\.close\(1000u32\.into\(\), b"Kicked by server"\)/);
    // Klien: keputusan device-scoped/banned/logout lewat helper murni bersama.
    expect(client).toMatch(/classifyKickPayload\(json, currentDeviceId\)/);
    expect(client).toMatch(/this\.emit\('force_logout', disposition\.payload\)/);
    expect(client).toMatch(/this\.emit\('auth:banned', \{ reason: disposition\.reason \}\)/);
    // Gateway WSS memakai event yang sama (kontrak tidak boleh menyimpang).
    expect(gateway).toMatch(/case TransportOpCode\.KICK:[\s\S]{0,120}sock\.emit\('force_logout', json\)/);
  });

  it('rate limit jalur data tidak dipasang di klien/gateway lokal', () => {
    // Gateway WSS memakai bucket HANDLER (satu hitungan; lihat gatewayParity.test.ts
    // di paket server) — di sini dipastikan pesan:send tetap lewat handler itu.
    expect(gateway).toMatch(/await handleChatMessage\(/);
    expect(gateway).toMatch(/await handleAck\(/);
    expect(gateway).toMatch(/await handlePresence\(/);
  });
});
