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
});
