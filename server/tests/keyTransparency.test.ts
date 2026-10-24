// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 WS-A / docs/32] Penulis log Key Transparency.
 *
 * Semua pengujian di sini bebas infra. Yang diuji bukan "apakah library bekerja"
 * melainkan kontrak NYX sendiri:
 *
 *   1. **Encoding protobuf** untuk `transparency.UpdateRequest` — field dan
 *      nilainya benar (search key, value, flag proof), karena kontrak ini harus
 *      cocok dengan binary Go `key-transparency-server` yang tidak kita ubah.
 *   2. **Framing gRPC** — header 5 byte dan pesan yang terpotong tidak dibuang
 *      diam-diam.
 *   3. **Nilai log v1** — kanonik (frozen), round-trip, menolak panjang salah.
 *   4. **Search key** = `0x75 || usernameHash(32)` dan tidak ada identitas lain
 *      di nilai yang masuk log.
 *   5. **Penulis** — idempoten, tidak pernah melempar, dan fail-visible (gagal
 *      mengembalikan alasan, bukan senyap sukses).
 *   6. **Live (opt-in)**: bila `KT_SERVER_URL` diset ke binary KT yang benar-benar
 *      jalan, satu penulisan nyata dilakukan dan ukuran pohon bertambah.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  KT_KEY_VERSION_RECOVERY,
  KT_KEY_VERSION_REGISTRATION,
  KT_USERNAME_HASH_PREFIX,
  KT_VALUE_V1_BYTES,
  buildKtLogEntry,
  clearKtDedupeForTests,
  commitKeyTransparencyEntry,
  decodeKtValue,
  decodeProtoFields,
  encodeKtUpdateRequest,
  encodeKtValue,
  frameGrpcMessage,
  ktEntryTag,
  ktSearchKey,
  parseGrpcFrames,
  publishKeyTransparencyEntry,
  summarizeKtUpdateResponse,
} from '../src/utils/keyTransparency.js';

/** Baca sumber relatif ke folder test — untuk guard wiring (lihat di bawah). */
const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');

const USERNAME_HASH = new Uint8Array(32).fill(0x5a);
const IDENTITY_KEY = new Uint8Array(32).fill(0x11);
const PQ_KEY = new Uint8Array(1216).fill(0x22);
const SIGNING_KEY = new Uint8Array(32).fill(0x33);
const USERNAME_HASH_B64 = Buffer.from(USERNAME_HASH).toString('base64url');

// --- helper protobuf untuk membangun respons uji ---------------------------

function varintBytes(value: bigint): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

function field(fieldNo: number, payload: Uint8Array | bigint): Uint8Array {
  if (typeof payload === 'bigint') {
    return new Uint8Array([...varintBytes(BigInt(fieldNo << 3)), ...varintBytes(payload)]);
  }
  return new Uint8Array([
    ...varintBytes(BigInt((fieldNo << 3) | 2)),
    ...varintBytes(BigInt(payload.length)),
    ...payload,
  ]);
}

/** `UpdateResponse` minimal: FullTreeHead{TreeHead{tree_size}} + vrf_proof. */
function buildUpdateResponse(treeSize: bigint, vrfProofLength: number): Uint8Array {
  const treeHead = field(1, treeSize); // TreeHead{ tree_size }
  const fullTreeHead = field(1, treeHead); // FullTreeHead{ tree_head }
  const vrfProof = new Uint8Array(vrfProofLength).fill(0x77);
  const parts = [field(1, fullTreeHead), field(2, vrfProof), field(3, new Uint8Array(8))];
  return new Uint8Array(parts.flatMap((p) => [...p]));
}

// ---------------------------------------------------------------------------

test('encodeKtUpdateRequest: search key, value, dan flag proof masuk field yang benar', () => {
  const searchKey = ktSearchKey(USERNAME_HASH);
  const value = encodeKtValue({
    identityKey: IDENTITY_KEY,
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 3,
    updatedAtDay: 20_000,
  });

  const encoded = encodeKtUpdateRequest({ searchKey, value, returnUpdateResponse: true });
  const fields = decodeProtoFields(encoded);

  assert.deepEqual(Array.from(fields.get(1)![0] as Uint8Array), Array.from(searchKey));
  assert.deepEqual(Array.from(fields.get(2)![0] as Uint8Array), Array.from(value));
  assert.equal(fields.get(5)![0], 1n);
  // `consistency` selalu dikirim (boleh kosong) — server KT menolak nil.
  assert.equal(fields.has(3), true);
  assert.equal((fields.get(3)![0] as Uint8Array).length, 0);

  const withoutProof = decodeProtoFields(encodeKtUpdateRequest({ searchKey, value }));
  assert.equal(withoutProof.has(5), false);

  // Consistency opsional (last/distinguished) juga ikut ter-encode.
  const withConsistency = decodeProtoFields(
    encodeKtUpdateRequest({ searchKey, value, consistency: { last: 7n, distinguished: 9n } })
  );
  const consistency = decodeProtoFields(withConsistency.get(3)![0] as Uint8Array);
  assert.equal(consistency.get(1)![0], 7n);
  assert.equal(consistency.get(2)![0], 9n);
});

test('framing gRPC: header 5 byte, pesan berurutan, sisa terpotong dikembalikan', () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([4, 5]);

  const frameA = frameGrpcMessage(a);
  assert.equal(frameA[0], 0, 'flag kompresi 0');
  assert.equal(new DataView(frameA.buffer).getUint32(1, false), 3);
  assert.deepEqual(Array.from(frameA.subarray(5)), [1, 2, 3]);

  const combined = new Uint8Array([...frameA, ...frameGrpcMessage(b), ...frameGrpcMessage(new Uint8Array(0))]);
  const parsed = parseGrpcFrames(combined);
  assert.equal(parsed.messages.length, 3);
  assert.deepEqual(Array.from(parsed.messages[0]!), [1, 2, 3]);
  assert.deepEqual(Array.from(parsed.messages[1]!), [4, 5]);
  assert.equal(parsed.messages[2]!.length, 0);
  assert.equal(parsed.rest.length, 0);

  // Frame terpotong → disimpan sebagai sisa utuh, bukan dibuang.
  const partial = new Uint8Array([...frameA, ...frameGrpcMessage(b).subarray(0, 3)]);
  const parsedPartial = parseGrpcFrames(partial);
  assert.equal(parsedPartial.messages.length, 1);
  assert.equal(parsedPartial.rest.length, 3);

  // Pesan terkompresi ditolak keras (belum didukung).
  const compressed = frameGrpcMessage(a);
  compressed[0] = 1;
  assert.throws(() => parseGrpcFrames(compressed), /GRPC_COMPRESSED_MESSAGE_UNSUPPORTED/);
});

test('summarizeKtUpdateResponse: ukuran pohon & panjang proof terbaca', () => {
  const summary = summarizeKtUpdateResponse(buildUpdateResponse(42n, 96));
  assert.equal(summary.treeSize, 42n);
  assert.equal(summary.vrfProofLength, 96);
  assert.equal(summary.hasUpdateProof, true);

  // Respons duplikat dari server KT = pesan kosong.
  assert.deepEqual(summarizeKtUpdateResponse(new Uint8Array(0)), {
    treeSize: null,
    vrfProofLength: null,
    hasUpdateProof: false,
  });
});

test('search key & nilai log v1', () => {
  const searchKey = ktSearchKey(USERNAME_HASH);
  assert.equal(searchKey.length, 33);
  assert.equal(searchKey[0], KT_USERNAME_HASH_PREFIX);
  assert.deepEqual(Array.from(searchKey.subarray(1)), Array.from(USERNAME_HASH));
  assert.throws(() => ktSearchKey(new Uint8Array(16)), /KT_USERNAME_HASH_LENGTH_INVALID/);

  const value = encodeKtValue({
    identityKey: IDENTITY_KEY,
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 7,
    updatedAtDay: 20_145,
  });
  assert.equal(value.length, KT_VALUE_V1_BYTES);

  const decoded = decodeKtValue(value);
  assert.equal(decoded.version, 1);
  assert.equal(decoded.keyVersion, 7);
  assert.equal(decoded.updatedAtDay, 20_145);
  assert.deepEqual(Array.from(decoded.identityKey), Array.from(IDENTITY_KEY));
  assert.deepEqual(Array.from(decoded.pqIdentityKey.subarray(0, 4)), [0x22, 0x22, 0x22, 0x22]);
  assert.equal(decoded.pqIdentityKey.length, 1216);

  assert.throws(
    () => encodeKtValue({ identityKey: new Uint8Array(31), pqIdentityKey: PQ_KEY, signingKey: SIGNING_KEY, keyVersion: 1, updatedAtDay: 1 }),
    /KT_IDENTITY_KEY_LENGTH_INVALID/
  );
  assert.throws(() => decodeKtValue(new Uint8Array(10)), /KT_VALUE_LENGTH_INVALID/);
});

test('buildKtLogEntry: entri tidak membocorkan identitas selain search key', () => {
  const entry = buildKtLogEntry({
    usernameHash: USERNAME_HASH_B64,
    identityKey: IDENTITY_KEY,
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 2,
    updatedAtDay: 20_100,
  });

  assert.equal(entry.keyVersion, 2);
  assert.equal(entry.searchKey[0], KT_USERNAME_HASH_PREFIX);
  assert.equal(entry.entryTag, ktEntryTag(entry.searchKey));
  assert.equal(entry.entryTag.length, 16);

  // UsernameHash hanya boleh muncul di search key (memang itu tujuannya).
  const valueHex = Buffer.from(entry.value).toString('hex');
  assert.ok(!valueHex.includes('5a5a5a5a5a5a5a5a'), 'nilai log tidak boleh memuat usernameHash');

  assert.throws(
    () => buildKtLogEntry({ usernameHash: Buffer.from(new Uint8Array(16)).toString('base64url'), identityKey: IDENTITY_KEY, pqIdentityKey: PQ_KEY, signingKey: SIGNING_KEY, keyVersion: 1, updatedAtDay: 1 }),
    /KT_USERNAME_HASH_LENGTH_INVALID/
  );
  assert.throws(
    () => buildKtLogEntry({ usernameHash: '', identityKey: IDENTITY_KEY, pqIdentityKey: PQ_KEY, signingKey: SIGNING_KEY, keyVersion: 1, updatedAtDay: 1 }),
    /KT_USERNAME_HASH_INVALID/
  );
});

test('penulis: idempoten, tidak melempar, dan fail-visible', async () => {
  // Unit test ini harus berperilaku sama dengan/tanpa `KT_SERVER_URL` di
  // lingkungan; env disimpan & dipulihkan supaya tidak menyentuh test lain.
  const previousKtUrl = process.env.KT_SERVER_URL;
  delete process.env.KT_SERVER_URL;
  clearKtDedupeForTests();

  const entry = buildKtLogEntry({
    usernameHash: USERNAME_HASH_B64,
    identityKey: IDENTITY_KEY,
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 1,
    updatedAtDay: 20_100,
  });

  // Nonaktif (tanpa KT_SERVER_URL & tanpa transport) → no-op, bukan error.
  assert.deepEqual(await commitKeyTransparencyEntry(entry), { ok: false, skipped: 'DISABLED' });

  let calls = 0;
  const okTransport = {
    async update() {
      calls++;
      return buildUpdateResponse(5n, 96);
    },
  };
  const first = await commitKeyTransparencyEntry(entry, { transport: okTransport, now: 1_000 });
  assert.equal(first.ok, true);
  assert.equal(first.treeSize, 5n);

  // Dedupe: penulisan kedua dengan nilai identik tidak dikirim lagi.
  const second = await commitKeyTransparencyEntry(entry, { transport: okTransport, now: 2_000 });
  assert.equal(second.skipped, 'DUPLICATE');
  assert.equal(calls, 1);

  // Perubahan kunci (nilai berbeda, versi sama) WAJIB tetap ditulis — inilah
  // yang membuat rotasi kunci terlihat di log.
  const rotated = buildKtLogEntry({
    usernameHash: USERNAME_HASH_B64,
    identityKey: new Uint8Array(32).fill(0x44),
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 1,
    updatedAtDay: 20_101,
  });
  const afterRotation = await commitKeyTransparencyEntry(rotated, { transport: okTransport, now: 3_000 });
  assert.equal(afterRotation.ok, true);
  assert.equal(calls, 2, 'nilai yang berubah tidak boleh ikut ter-dedupe');

  // Setelah TTL dedupe, entri ditulis ulang (server KT sendiri idempoten).
  const third = await commitKeyTransparencyEntry(entry, { transport: okTransport, now: 2_000 + 11 * 60 * 1000 });
  assert.equal(third.ok, true);
  assert.equal(calls, 3);

  // Kegagalan transport → hasil `ok: false` + alasan, dan tidak melempar.
  const failing = await commitKeyTransparencyEntry(entry, {
    transport: {
      async update() {
        throw new Error('KT_UPDATE_TIMEOUT');
      },
    },
    now: 9_000_000,
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.reason, 'KT_UPDATE_TIMEOUT');

  clearKtDedupeForTests();
  if (previousKtUrl !== undefined) process.env.KT_SERVER_URL = previousKtUrl;
});

/**
 * [docs/35 §35.7 Fase 7] Dual-write transisi v1 + v2.
 *
 * Entri yang sama harus masuk ke DUA pohon (nilai byte identik), dedupe terpisah
 * per log, dan kegagalan satu log tidak boleh membatalkan log lain — tetapi juga
 * tidak boleh dilaporkan sebagai sukses penuh.
 */
test('dual-write: entri sama ke log v1 dan v2, dedupe dan kegagalan terpisah', async () => {
  const entry = buildKtLogEntry({
    usernameHash: USERNAME_HASH_B64,
    identityKey: IDENTITY_KEY,
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 1,
    updatedAtDay: 20_100,
  });

  let v1Calls = 0;
  let v2Calls = 0;
  let v2Requests: Uint8Array[] = [];
  const v1 = {
    async update() {
      v1Calls++;
      return buildUpdateResponse(7n, 96);
    },
  };
  const v2 = {
    async update(request: Uint8Array) {
      v2Calls++;
      v2Requests.push(request);
      return buildUpdateResponse(7n, 0);
    },
  };

  clearKtDedupeForTests();
  const both = await commitKeyTransparencyEntry(entry, { transport: v1, v2Transport: v2, now: 1_000 });
  assert.equal(both.ok, true);
  assert.equal(both.treeSize, 7n);
  assert.equal(both.v2?.ok, true);
  assert.equal(v1Calls, 1);
  assert.equal(v2Calls, 1);

  // Nilai protobuf yang dikirim ke kedua log identik (search key + value).
  const fields = decodeProtoFields(v2Requests[0]!);
  assert.deepEqual(Array.from(fields.get(1)![0] as Uint8Array), Array.from(entry.searchKey));
  assert.deepEqual(Array.from(fields.get(2)![0] as Uint8Array), Array.from(entry.value));

  // Dedupe per log: nilai baru ditulis ke v1 saja dulu, lalu dual-write →
  // v1 dedupe tetapi v2 (yang belum punya nilai itu) tetap ditulis.
  const rotatedV1Only = buildKtLogEntry({
    usernameHash: USERNAME_HASH_B64,
    identityKey: new Uint8Array(32).fill(0x46),
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 1,
    updatedAtDay: 20_103,
  });
  const v1Only = await commitKeyTransparencyEntry(rotatedV1Only, { transport: v1, now: 2_000 });
  assert.equal(v1Only.ok, true);
  assert.equal(v1Calls, 2);

  v2Calls = 0;
  const onlyV2 = await commitKeyTransparencyEntry(rotatedV1Only, {
    transport: v1,
    v2Transport: v2,
    now: 2_100,
  });
  assert.equal(v1Calls, 2, 'v1 tidak ditulis ulang (dedupe v1)');
  assert.equal(v2Calls, 1, 'v2 tetap ditulis walau v1 dedupe');
  assert.equal(onlyV2.ok, true);
  assert.notEqual(onlyV2.skipped, 'DUPLICATE');

  // Kedua log duplikat → skipped DUPLICATE di tingkat atas.
  const duplicate = await commitKeyTransparencyEntry(rotatedV1Only, {
    transport: v1,
    v2Transport: v2,
    now: 2_500,
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.skipped, 'DUPLICATE');

  // Log v2 gagal: v1 tetap sukses, tetapi hasil gabungan TIDAK boleh `ok`.
  let v1AfterFailure = 0;
  const failingV2 = {
    async update(): Promise<Uint8Array> {
      throw new Error('KT_V2_UPDATE_TIMEOUT');
    },
  };
  const rotated = buildKtLogEntry({
    usernameHash: USERNAME_HASH_B64,
    identityKey: new Uint8Array(32).fill(0x45),
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 1,
    updatedAtDay: 20_102,
  });
  const partial = await commitKeyTransparencyEntry(rotated, {
    transport: {
      async update() {
        v1AfterFailure++;
        return buildUpdateResponse(8n, 96);
      },
    },
    v2Transport: failingV2,
    now: 3_000,
  });
  assert.equal(v1AfterFailure, 1, 'kegagalan v2 tidak membatalkan penulisan v1');
  assert.equal(partial.ok, false, 'satu log tertinggal bukan sukses penuh');
  assert.equal(partial.reason, 'KT_V2_UPDATE_TIMEOUT');
  assert.equal(partial.v2?.ok, false);

  clearKtDedupeForTests();
});

test('publishKeyTransparencyEntry: bentuk tidak sah tidak ditulis ke log', async () => {
  let calls = 0;
  const transport = {
    async update() {
      calls++;
      return new Uint8Array(0);
    },
  };

  const bad = await publishKeyTransparencyEntry(
    {
      usernameHash: Buffer.from(new Uint8Array(16)).toString('base64url'),
      identityKey: IDENTITY_KEY,
      pqIdentityKey: PQ_KEY,
      signingKey: SIGNING_KEY,
      keyVersion: 1,
      updatedAtDay: 1,
    },
    { transport }
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'KT_USERNAME_HASH_LENGTH_INVALID');
  assert.equal(calls, 0, 'tidak ada penulisan saat entri tidak sah');

  const good = await publishKeyTransparencyEntry(
    {
      usernameHash: USERNAME_HASH_B64,
      identityKey: IDENTITY_KEY,
      pqIdentityKey: PQ_KEY,
      signingKey: SIGNING_KEY,
      keyVersion: 4,
      updatedAtDay: 20_100,
    },
    { transport }
  );
  assert.equal(good.ok, true);
  assert.equal(calls, 1);
});

/**
 * [2026-10-15] Konsekuensi jalur PEMULIHAN AKUN.
 *
 * Pemulihan menukar kunci identitas — tepat peristiwa yang harus terlihat di
 * log. Search key log adalah `0x75 || Argon2id(username)` (32 byte), sedangkan
 * blind index yang dikembalikan server ke klien berbentuk 64 hex (HMAC pepper).
 * Klien yang mengirim bentuk ter-pepper (bundel lama, atau pemulihan lewat hash
 * ID) karena itu **tidak bisa** dicatat: server tak punya cara menurunkan search
 * key dari pepper.
 *
 * Test ini mengunci dua hal: (a) bentuk ter-pepper selalu berakhir dengan alasan
 * `KT_USERNAME_HASH_LENGTH_INVALID` — persis alasan yang dipakai
 * `publishKeyTransparencyEntry` untuk menghitung metrik `unsupported_identifier`
 * (jadi kejadiannya TERLIHAT, bukan tercampur dengan input cacat lain);
 * (b) bentuk Argon2id (setelah klien diperbaiki) benar-benar masuk ke log.
 */
test('jalur pemulihan: bentuk ter-pepper dilewati dengan alasan yang bisa dibedakan', async () => {
  // 64 hex = bentuk yang dikembalikan server (pepperedIdentifier).
  const peppered = 'a1'.repeat(32);
  assert.equal(peppered.length, 64);

  let calls = 0;
  const transport = {
    async update() {
      calls++;
      return new Uint8Array(0);
    },
  };
  const entry = {
    identityKey: IDENTITY_KEY,
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 2,
    updatedAtDay: 20_100,
  };

  const skipped = await publishKeyTransparencyEntry({ usernameHash: peppered, ...entry }, { transport });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'KT_USERNAME_HASH_LENGTH_INVALID');
  assert.equal(calls, 0, 'bentuk ter-pepper tidak boleh ditulis ke log');

  // Bentuk Argon2id 32 byte (yang dihitung klien dari username) DITERIMA →
  // inilah yang membuat pemulihan akun punya jejak di log.
  clearKtDedupeForTests();
  const published = await publishKeyTransparencyEntry({ usernameHash: USERNAME_HASH_B64, ...entry }, { transport });
  assert.equal(published.ok, true, `penulisan KT gagal: ${published.reason ?? 'unknown'}`);
  assert.equal(calls, 1);
});

/**
 * [docs/30 §30.5 WS-A] Wiring penulis di route: **registrasi = keyVersion 1**,
 * **pemulihan = keyVersion 2**, keduanya fire-and-forget SETELAH commit DB, dan
 * presisi waktu hanya sampai bucket harian.
 *
 * Kenapa guard sumber, bukan test perilaku: dua situs itu hidup di
 * `routes/auth.ts` (1264 baris; butuh Prisma + Redis untuk dijalankan), sehingga
 * jalur ini tidak bisa diuji perilakunya tanpa infra. Yang paling mudah rusak
 * tanpa ketahuan justru detail kecil ini: pemulihan lupa menulis ke log (padahal
 * penukaran kunci identitas adalah peristiwa yang paling WAJIB terlihat),
 * `keyVersion` tertukar, respons registrasi jadi menunggu log, atau timestamp
 * berpresisi detik masuk ke log publik.
 */
test('wiring: registrasi (keyVersion 1) + pemulihan (keyVersion 2), fire-and-forget, bucket harian', () => {
  const auth = read('../src/routes/auth.ts');

  const calls = auth.match(/void publishKeyTransparencyEntry\(\{[\s\S]*?\n    \}\);/g) ?? [];
  assert.equal(calls.length, 2, 'dua situs: registrasi + pemulihan akun');

  // Label alur datang dari KONSTANTA (bukan angka sihir): dua jalur boleh berbeda
  // makna tanpa ada yang menebak angka. Rotasi memakai kunci terpisah di
  // `ktIdentityLog.ts` (lihat guard `ktIdentityLog.test.ts`).
  const versionOne = calls.filter((call) => /keyVersion: KT_KEY_VERSION_REGISTRATION,/.test(call));
  const versionTwo = calls.filter((call) => /keyVersion: KT_KEY_VERSION_RECOVERY,/.test(call));
  assert.equal(versionOne.length, 1, 'registrasi menulis dengan label registrasi');
  assert.equal(versionTwo.length, 1, 'pemulihan menulis dengan label pemulihan');
  assert.doesNotMatch(auth, /keyVersion: [0-9]+,\n\s+updatedAtDay/, 'tidak ada label alur berbentuk angka sihir');

  for (const call of calls) {
    // Fire-and-forget: registrasi/pemulihan tidak menunggu log KT.
    assert.doesNotMatch(call, /await publishKeyTransparencyEntry/, 'log tidak boleh memblokir respons');
    // Presisi waktu: bucket harian (sama seperti `docs/32` — tanpa detik).
    assert.match(
      call,
      /updatedAtDay: Math\.floor\(dayBucket\(\)\.getTime\(\) \/ 86_400_000\),/,
      'updatedAtDay = bucket harian'
    );
    // Material publik saja: kunci yang benar-benar disimpan di device.
    assert.match(call, /identityKey: Buffer\.from\(publicKey, 'base64url'\),/);
    assert.match(call, /signingKey: Buffer\.from\(signingKey, 'base64url'\),/);
    assert.doesNotMatch(
      call,
      /userId|passwordHash|encryptedPrivateKey|fingerprint|installationTag|req\.ip/,
      'log publik tidak boleh memuat identitas/rahasia'
    );
  }

  // "Log ditulis setelah commit DB sukses" (docs/30 §30.5): tiap situs berada
  // setelah tulisan DB terdekat sebelumnya — registrasi memakai nested create
  // (`prisma.user.create`), pemulihan memakai `prisma.$transaction`.
  let cursor = 0;
  for (const label of ['registrasi', 'pemulihan'] as const) {
    const publishIndex = auth.indexOf('void publishKeyTransparencyEntry({', cursor);
    assert.ok(publishIndex > -1, `situs ${label} tidak ditemukan`);

    const writeIndex = auth.lastIndexOf('await prisma.', publishIndex);
    assert.ok(
      writeIndex > -1 && writeIndex < publishIndex,
      `${label}: penulisan log harus setelah tulisan DB`
    );
    // Masih di dalam handler: respons dikirim SESUDAH penulisan dijadwalkan.
    assert.ok(auth.indexOf('res.', publishIndex) > publishIndex, `${label}: respons setelah penulisan`);

    cursor = publishIndex + 1;
  }
});

/**
 * [docs/30 §30.5 WS-A] Invariant penulis: **setiap jalur yang menimpa kunci
 * identitas perangkat** harus diketahui status log-nya.
 *
 * Penulis log hanya dipanggil di dua tempat (`routes/auth.ts`: registrasi +
 * pemulihan), padahal jalur lain sama-sama mengubah `Device.publicKey`:
 * `POST /keys/prekey-bundle` (`routes/keys.ts`), `PUT /users/me/keys`
 * (`routes/users.ts`), dan re-sync kunci saat `POST /auth/login` (di
 * `routes/auth.ts`). Ketiganya **tidak** menulis ke log — inilah separuh isi
 * residual `docs/32` §32.7 poin 2: setelah rotasi kunci, log masih memuat kunci
 * LAMA, sehingga peer yang memverifikasi bundle melihat verdict `mismatch`
 * (kunci tersaji ≠ kunci log) dan gate kirim `peerIdentityTrust` menyimpannya
 * sebagai konflik kunci (bukan sebagai rotasi biasa).
 *
 * Test ini tidak mengubah perilaku: ia mengunci **daftar** jalur penulis kunci
 * identitas supaya (a) jalur baru tidak lolos tanpa dipertimbangkan untuk log,
 * dan (b) jalur yang mulai menulis log memaksa pembaruan dokumen (docs/30 §30.5
 * + docs/32 §32.7 + test ini), bukan sekadar mengubah assertion.
 */
test('wiring: jalur yang menimpa Device.publicKey = 3 tertulis + 1 dikecualikan + 1 bukan penulisan', () => {
  const srcRoot = join(here, '..', 'src');
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) sources.push(full);
    }
  };
  walk(srcRoot);

  // Pola yang dipakai SELURUH jalur tulis kunci identitas saat ini.
  // `(?!d\.publicKey)` menyisihkan serializer bacaan di `utils/mappers.ts`.
  const writePattern = /publicKey: Buffer\.from\((?!d\.publicKey)/;
  const read = (file: string) => readFileSync(join(srcRoot, file), 'utf8');
  const writers = sources
    .filter((file) => writePattern.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(srcRoot.length + 1).replace(/\\/g, '/'))
    .sort();

  assert.deepEqual(
    writers,
    ['network/realtimeHandlers.ts', 'routes/auth.ts', 'routes/engine.ts', 'routes/keys.ts', 'routes/users.ts'],
    'jalur baru yang menimpa kunci identitas: tentukan dulu status log-nya (docs/32 §32.7 poin 2)'
  );

  // Bukan penulisan: pencarian device berdasarkan kunci (`where: { publicKey: ... }`).
  assert.match(
    read('network/realtimeHandlers.ts'),
    /where: \{ publicKey: Buffer\.from\(/,
    'realtimeHandlers hanya mencari device dengan kunci itu, bukan menimpanya'
  );

  // Tertulis ke log: registrasi + pemulihan (guard wiring di atas) dan tiga jalur
  // rotasi (guard `ktIdentityLog.test.ts`).
  for (const logged of ['routes/auth.ts', 'routes/keys.ts', 'routes/users.ts'] as const) {
    assert.match(read(logged), /publishKeyTransparencyEntry\(|publishIdentityKeyChange\(/, `${logged} menulis log`);
  }

  // Dikecualikan dengan alasan yang tetap berlaku: device dummy iframe B2B
  // (`routes/engine.ts`) tidak punya identifier Argon2id — akunnya tenant dengan
  // kunci dummy, jadi tidak ada search key yang bisa ditulis. Bila ini berubah
  // (kunci nyata untuk tenant), jalur ini WAJIB ditambahkan ke penulis log.
  assert.doesNotMatch(
    read('routes/engine.ts'),
    /publishKeyTransparencyEntry\(|publishIdentityKeyChange\(/,
    'engine.ts (tenant/dummy) dikecualikan — lihat docs/32 §32.7 poin 2'
  );
});

/**
 * ⚠️ Test penulisan **live** hanya jalan dengan opt-in eksplisit.
 *
 * Jangan kembali ke `skip: !process.env.KT_SERVER_URL`: `server/.env` selalu
 * mengisi variabel itu dan `src/config.ts` memuat dotenv, sehingga gate itu
 * membuat `pnpm test` menulis entri sungguhan ke log yang sedang dikonfigurasi
 * (log KT append-only → tidak bisa dihapus). Terjadi 2026-10-17 pada jalur
 * rotasi: dua entri uji masuk log self-host saat suite penuh dijalankan.
 * Guard-nya ada di `ktIdentityLog.test.ts` (`guard: penulisan live …`).
 */
const KT_LIVE_WRITE =
  process.env.NYX_KT_LIVE_WRITE === '1' && Boolean(process.env.KT_SERVER_URL);

test('live: penulisan nyata ke binary KT (opt-in NYX_KT_LIVE_WRITE=1)', { skip: !KT_LIVE_WRITE }, async () => {
  clearKtDedupeForTests();
  const usernameHash = new Uint8Array(32);
  for (let i = 0; i < 32; i++) usernameHash[i] = (i * 7 + Date.now() % 251) & 0xff;

  const result = await publishKeyTransparencyEntry({
    usernameHash: Buffer.from(usernameHash).toString('base64url'),
    identityKey: IDENTITY_KEY,
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 1,
    updatedAtDay: 20_100,
  });

  assert.equal(result.ok, true, `penulisan KT gagal: ${result.reason ?? 'unknown'}`);
  assert.ok(result.treeSize !== null && result.treeSize >= 1n, 'ukuran pohon harus bertambah setelah update');
});


test('targets: pilih v2 saja tanpa menyentuh v1', async () => {
  clearKtDedupeForTests();
  let v1Calls = 0;
  let v2Calls = 0;
  const entry = buildKtLogEntry({
    usernameHash: USERNAME_HASH_B64,
    identityKey: IDENTITY_KEY,
    pqIdentityKey: PQ_KEY,
    signingKey: SIGNING_KEY,
    keyVersion: 1,
    updatedAtDay: 20_000,
  });
  const result = await commitKeyTransparencyEntry(entry, {
    transport: {
      async update() {
        v1Calls++;
        return new Uint8Array(0);
      },
    },
    v2Transport: {
      async update() {
        v2Calls++;
        return new Uint8Array(0);
      },
    },
    targets: ['v2'],
    now: 1_000,
  });
  assert.equal(v1Calls, 0);
  assert.equal(v2Calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.v2?.ok, true);
  clearKtDedupeForTests();
});
