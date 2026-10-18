#!/usr/bin/env node
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Alat bantu root attestation (tanpa dependensi).
 *
 * Attestation perangkat nyata (TPM/Windows Hello, Android Key Attestation,
 * packed YubiKey, `apple`) sering mengirim `x5c` hanya leaf + intermediate;
 * root-nya hidup di trust store vendor. Server butuh **sertifikat root**, bukan
 * cuma fingerprint, untuk membangun jalur (`ABUSE_ATTESTATION_ROOTS_FILE`).
 *
 * Perintah:
 *   node scripts/attestation-roots.mjs inspect <cert.pem|cert.der> [...]
 *   node scripts/attestation-roots.mjs bundle --out ops/attestation/roots.pem \
 *     <cert.pem|cert.der> [...]
 *   node scripts/attestation-roots.mjs refresh [--out <pem>] [--meta <json>]
 *     [--sources mds,android,apple] [--mds-root <pem>] [--keep-expired] [--dry-run]
 *   node scripts/attestation-roots.mjs check [--bundle <pem>] [--meta <json>] [--strict]
 *
 * `inspect` mencetak subject + SHA-256 fingerprint (format yang dipakai
 * `ABUSE_ATTESTATION_ROOTS`). `bundle` menormalkan input menjadi satu berkas
 * PEM, membuang duplikat berdasarkan fingerprint, dan menolak sertifikat yang
 * bukan CA (root attestation harus `basicConstraints=CA:TRUE`).
 *
 * `refresh` mengunduh dan MEMVERIFIKASI sumber, lalu menulis bundle + metadata
 * (unduhan 429/5xx diulang dengan `Retry-After`):
 *   - FIDO MDS (https://mds.fidoalliance.org/): blob JWT. Tanda tangan JWS
 *     diverifikasi dengan kunci publik leaf `x5c` (RS256/ES256), seluruh tautan
 *     rantai diverifikasi, identitas leaf harus `CN=mds.fidoalliance.org`, dan
 *     fingerprint rantai dicatat di metadata sebagai pin TOFU — perubahan di
 *     refresh berikutnya adalah error kecuali `--accept-new-mds-chain`.
 *     `--mds-root <pem>` menutup celah terakhir itu dengan anchor GlobalSign
 *     yang dipin operator.
 *   - Android: https://android.googleapis.com/attestation/root (JSON array PEM).
 *   - Apple: https://www.apple.com/certificateauthority/Apple_WebAuthn_Root_CA.pem
 * Filter yang dipakai (dan dicatat di metadata): hanya CA, hanya yang masih
 * berlaku (kecuali `--keep-expired`), dedup per SHA-256, dan entri MDS dengan
 * status kompromi/revoked DIBUANG seluruhnya (`REVOKED`,
 * `ATTESTATION_KEY_COMPROMISE`, `USER_KEY_*`, `USER_VERIFICATION_BYPASS`).
 *
 * `check` memeriksa bundle yang sudah ada: tanggal `nextUpdate` MDS di metadata,
 * root kedaluwarsa/akan kedaluwarsa, dan apakah bundle masih sama dengan yang
 * dicatat metadata. `--strict` menjadikan setiap peringatan exit code 2 (untuk
 * cron); tanpa itu selalu exit 0 selama berkas bisa dibaca.
 *
 * Tanpa dependensi: verifikasi JWS/rantai memakai `node:crypto`. Sumber root
 * TIDAK dipilih oleh alat ini — ia hanya menyegarkan daftar yang sudah
 * diverifikasi; keputusan siapa yang layak dipercaya tetap milik operator.
 * Lihat ops/attestation/README.md untuk alur lengkap dan batas keamanannya.
 */

import { X509Certificate, createHash, verify as verifySignature } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Pemakaian:
  node scripts/attestation-roots.mjs inspect <cert.pem|cert.der> [...]
  node scripts/attestation-roots.mjs bundle --out <keluaran.pem> <cert.pem|cert.der> [...]
  node scripts/attestation-roots.mjs refresh [--out <pem>] [--meta <json>]
      [--sources mds,android,apple] [--mds-root <pem>] [--accept-new-mds-chain]
      [--keep-expired] [--dry-run]
  node scripts/attestation-roots.mjs check [--bundle <pem>] [--meta <json>] [--strict]`;

const DEFAULT_BUNDLE = resolve(REPO_ROOT, 'ops/attestation/roots.pem');
const MDS_URL = 'https://mds.fidoalliance.org/';
const ANDROID_URL = 'https://android.googleapis.com/attestation/root';
const APPLE_URL = 'https://www.apple.com/certificateauthority/Apple_WebAuthn_Root_CA.pem';

/** Status MDS yang membuat SEMUA root milik entri itu tidak layak dipercaya. */
const COMPROMISED_STATUSES = new Set([
  'REVOKED',
  'ATTESTATION_KEY_COMPROMISE',
  'USER_KEY_REMOTE_COMPROMISE',
  'USER_KEY_PHYSICAL_COMPROMISE',
  'USER_VERIFICATION_BYPASS',
]);

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Baca satu berkas menjadi daftar sertifikat (PEM bisa memuat banyak). */
function readCerts(path) {
  const raw = readFileSync(path);
  const text = raw.toString('utf8');
  const blocks = text.match(PEM_BLOCK);
  if (blocks && blocks.length > 0) {
    return blocks.map((block) => new X509Certificate(block));
  }
  try {
    return [new X509Certificate(raw)];
  } catch {
    throw new Error(`${path}: bukan sertifikat PEM/DER yang bisa dibaca`);
  }
}

const fingerprint = (cert) => cert.fingerprint256.trim().toUpperCase();

function collect(paths) {
  const byFingerprint = new Map();
  for (const path of paths) {
    for (const cert of readCerts(path)) {
      byFingerprint.set(fingerprint(cert), cert);
    }
  }
  if (byFingerprint.size === 0) throw new Error('tidak ada sertifikat yang terbaca');
  return [...byFingerprint.entries()];
}

function inspect(paths) {
  for (const [fp, cert] of collect(paths)) {
    console.log(`sha256: ${fp}`);
    console.log(`  subject: ${cert.subject.replace(/\n/g, ', ')}`);
    console.log(`  issuer:  ${cert.issuer.replace(/\n/g, ', ')}`);
    console.log(`  CA:      ${cert.ca}   valid: ${cert.validFrom} .. ${cert.validTo}`);
    if (!cert.ca) {
      console.warn('  ⚠️  bukan CA — jangan dipakai sebagai root attestation');
    }
  }
}

function bundle(paths, out) {
  const entries = collect(paths);
  const nonCa = entries.filter(([, cert]) => !cert.ca);
  if (nonCa.length > 0) {
    for (const [fp, cert] of nonCa) {
      console.error(`❌ bukan CA (basicConstraints): ${fp} — ${cert.subject.replace(/\n/g, ', ')}`);
    }
    throw new Error('root attestation harus CA; perbaiki daftar input sebelum menulis bundle');
  }
  const pem = entries.map(([, cert]) => cert.toString().trim()).join('\n') + '\n';
  writeFileSync(out, pem);
  console.log(`✅ ${entries.length} root ditulis ke ${out}`);
  for (const [fp] of entries) console.log(`   ${fp}`);
}

// ---------------------------------------------------------------------------
// Filter bersama semua sumber
// ---------------------------------------------------------------------------

/**
 * Saring kandidat root: wajib CA, wajib masih berlaku (kecuali `keepExpired`),
 * dan dedup per fingerprint. `source` dipertahankan supaya metadata bisa
 * menjelaskan dari mana tiap anchor berasal.
 *
 * Root kedaluwarsa DIBUANG, bukan disimpan: sertifikat itu tidak bisa
 * memverifikasi tanda tangan baru, dan menyimpannya hanya membuat bundle tampak
 * lengkap sambil tetap gagal saat dipakai.
 */
function filterRoots(candidates, { now, keepExpired }) {
  const kept = new Map();
  const dropped = { unparseable: 0, non_ca: 0, expired: 0, duplicate: 0 };
  for (const candidate of candidates) {
    let cert;
    try {
      cert = candidate.cert ?? new X509Certificate(candidate.der);
    } catch {
      dropped.unparseable += 1;
      continue;
    }
    if (!cert.ca) {
      dropped.non_ca += 1;
      continue;
    }
    if (!keepExpired && new Date(cert.validTo) <= now) {
      dropped.expired += 1;
      continue;
    }
    const fp = fingerprint(cert);
    if (kept.has(fp)) {
      dropped.duplicate += 1;
      continue;
    }
    kept.set(fp, { cert, fp, source: candidate.source, aaguid: candidate.aaguid ?? null });
  }
  return { kept: [...kept.values()], dropped };
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Ambil blok PEM dari berkas vendor yang mungkin membungkusnya sebagai JSON
 * (Android menyajikan JSON array string PEM dengan `\n` literal). Meng-unescape
 * dulu jauh lebih aman daripada mencocokkan regex pada teks ber-escape: blok
 * yang setengah ter-escape lolos regex tetapi ditolak `X509Certificate`.
 */
function extractPemBlocks(raw) {
  return raw.replace(/\\r\\n|\\n|\\r/g, '\n').match(PEM_BLOCK) ?? [];
}

function daysUntil(iso, now) {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;
  return Math.floor((target.getTime() - now.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// FIDO MDS: unduh, verifikasi JWS, verifikasi rantai
// ---------------------------------------------------------------------------

/**
 * Unduh teks dengan percobaan ulang untuk 429/5xx.
 *
 * MDS membalas 429 ("Too many requests") bila dipanggil berdekatan. Tanpa ini,
 * refresh yang dijadwalkan cron bisa gagal hanya karena bertabrakan dengan
 * operator lain, dan bundle tetap basi sampai minggu berikutnya — kegagalan yang
 * justru ingin dicegah alat ini. `Retry-After` dihormati (dibatasi 120 detik)
 * supaya tidak menabrak lagi.
 *
 * 403/404 tidak diulang: itu jawaban pasti (URL berubah/akses ditolak), dan
 * mencoba tiga kali hanya menyembunyikan penyebabnya.
 */
async function fetchText(url, { attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'nyx-attestation-roots/1.0 (+https://github.com/h4nzs/nyx-chat)' },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) return response.text();

    const retryable = response.status === 429 || response.status >= 500;
    const detail = `${url}: HTTP ${response.status} ${response.statusText}`.trim();
    if (!retryable || attempt === attempts) {
      throw new Error(detail);
    }
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter, 120) * 1000
      : 5_000 * attempt;
    console.warn(`⚠️  ${detail} — coba lagi dalam ${Math.round(waitMs / 1000)}s (${attempt}/${attempts - 1}).`);
    lastError = detail;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error(lastError ?? `${url}: gagal diunduh`);
}

const JWS_ALGORITHMS = {
  RS256: { algorithm: 'RSA-SHA256' },
  RS384: { algorithm: 'RSA-SHA384' },
  RS512: { algorithm: 'RSA-SHA512' },
  ES256: { algorithm: 'sha256', dsaEncoding: 'ieee-p1363' },
  ES384: { algorithm: 'sha384', dsaEncoding: 'ieee-p1363' },
};

/**
 * Verifikasi tanda tangan JWS dan setiap tautan `x5c`.
 *
 * Yang diperiksa:
 *   1. tanda tangan JWS dengan kunci publik leaf (bukan dengan leaf sebagai CA);
 *   2. setiap sertifikat ditandatangani oleh sertifikat berikutnya;
 *   3. masa berlaku seluruh rantai;
 *   4. identitas leaf cocok dengan host sumber (`CN=mds.fidoalliance.org`) —
 *      domain yang juga dilindungi TLS saat pengunduhan.
 *
 * Anchor: bila `pinnedRoot` diberikan, sertifikat puncak wajib ditandatangani
 * anchor itu. Bila tidak, puncak boleh berhenti di intermediate (rantai MDS
 * nyata berhenti di GlobalSign Root R46 yang tidak ikut `x5c`); dalam kasus itu
 * pemanggil memakai pin TOFU dari metadata (`assertMdsChainContinuity`).
 */
function verifyJwsChain(jwt, { expectedHost, pinnedRoots, now }) {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('blob MDS bukan JWT tiga bagian');
  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new Error('header JWT MDS tidak bisa dibaca');
  }
  if (!Array.isArray(header.x5c) || header.x5c.length === 0) {
    throw new Error('header JWT MDS tidak memuat x5c — tidak ada rantai untuk diverifikasi');
  }
  const algorithm = JWS_ALGORITHMS[header.alg];
  if (!algorithm) throw new Error(`algoritma JWS MDS tidak didukung: ${header.alg}`);

  const chain = header.x5c.map((b64) => new X509Certificate(Buffer.from(b64, 'base64')));
  const leaf = chain[0];
  if (leaf.ca) throw new Error('leaf JWT MDS bertanda CA:true — bukan sertifikat penanda tangan');

  const signature = Buffer.from(parts[2], 'base64url');
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  const signatureValid = verifySignature(algorithm.algorithm, signingInput, algorithm.dsaEncoding
    ? { key: leaf.publicKey, dsaEncoding: algorithm.dsaEncoding }
    : leaf.publicKey, signature);
  if (!signatureValid) throw new Error('tanda tangan JWS MDS TIDAK valid untuk kunci leaf x5c');

  for (let i = 0; i < chain.length - 1; i += 1) {
    if (!chain[i].checkIssued(chain[i + 1])) {
      throw new Error(`rantai MDS tidak nyambung: [${i}] tidak diterbitkan oleh [${i + 1}]`);
    }
    if (!chain[i].verify(chain[i + 1].publicKey)) {
      throw new Error(`tanda tangan rantai MDS tidak valid: [${i}] oleh [${i + 1}]`);
    }
  }
  for (const cert of chain) {
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) <= now) {
      throw new Error(`sertifikat rantai MDS di luar masa berlaku: ${cert.subject.replace(/\n/g, ', ')} (${cert.validTo})`);
    }
  }

  const expected = expectedHost.replace(/^www\./, '').toLowerCase();
  const subject = leaf.subject.replace(/\n/g, ', ');
  const commonName = /CN=([^,]+)/.exec(subject)?.[1]?.trim().toLowerCase() ?? '';
  if (commonName !== expected) {
    throw new Error(`leaf JWT MDS bukan untuk ${expected} (CN=${commonName})`);
  }
  if (!/O=.*Fido Alliance/i.test(subject)) {
    throw new Error(`leaf JWT MDS tidak diterbitkan untuk FIDO Alliance: ${subject}`);
  }

  // Anchor opsional: kalau operator memin root, rantai HARUS berakhir di sana.
  if (pinnedRoots.length > 0) {
    const top = chain[chain.length - 1];
    const anchored = pinnedRoots.some(
      (root) =>
        fingerprint(root) === fingerprint(top) ||
        (top.checkIssued(root) && top.verify(root.publicKey))
    );
    if (!anchored) {
      throw new Error(
        `rantai MDS tidak berakhir di root yang dipin (puncak: ${top.subject.replace(/\n/g, ', ')}). Perbarui --mds-root bila GlobalSign benar-benar merotasi root.`
      );
    }
  }

  return { header, chain, chainFingerprints: chain.map((cert) => fingerprint(cert)) };
}

/**
 * Pin TOFU rantai MDS: metadata refresh sebelumnya mencatat fingerprint rantai.
 * Rantai yang berubah tanpa penjelasan adalah persis kejadian yang ingin
 * terlihat (sertifikat MDS dipalsukan di jalur, proxy, atau rotasi vendor),
 * jadi default-nya ERROR, bukan diam-diam diterima.
 */
function assertMdsChainContinuity({ chainFingerprints, previousMeta, acceptNewChain }) {
  const previous = previousMeta?.mds?.chain?.map((entry) => entry.sha256?.toUpperCase()).filter(Boolean) ?? [];
  if (previous.length === 0) {
    console.warn('⚠️  Pin rantai MDS belum ada di metadata: menyimpan rantai saat ini sebagai pin TOFU.');
    console.warn(`   leaf: ${chainFingerprints[0]} — periksa manual sekali, lalu simpan metadata ini.`);
    return;
  }
  if (previous.join(',') === chainFingerprints.join(',')) return;
  if (acceptNewChain) {
    console.warn('⚠️  Rantai MDS BERUBAH dan diterima lewat --accept-new-mds-chain:');
    console.warn(`   lama: ${previous.join(' | ')}`);
    console.warn(`   baru: ${chainFingerprints.join(' | ')}`);
    return;
  }
  throw new Error(
    `rantai MDS berubah dari pin di metadata (lama: ${previous[0]}…, baru: ${chainFingerprints[0]}…). Periksa manual (sertifikat mds.fidoalliance.org/root) lalu ulangi dengan --accept-new-mds-chain.`
  );
}

/** Kumpulan root per entri MDS, memakai filter status kompromi. */
function mdsCandidates(payload) {
  const candidates = [];
  const dropped = { compromised_entry: 0, no_roots: 0, status: {} };
  for (const entry of payload.entries ?? []) {
    const statuses = (entry.statusReports ?? []).map((report) => report.status);
    for (const status of statuses) dropped.status[status] = (dropped.status[status] ?? 0) + 1;
    if (statuses.some((status) => COMPROMISED_STATUSES.has(status))) {
      dropped.compromised_entry += 1;
      continue;
    }
    const roots = entry.metadataStatement?.attestationRootCertificates ?? [];
    if (roots.length === 0) {
      dropped.no_roots += 1;
      continue;
    }
    for (const b64 of roots) {
      candidates.push({ der: Buffer.from(b64, 'base64'), source: 'fido-mds', aaguid: entry.aaguid });
    }
  }
  return { candidates, dropped };
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

/**
 * Opsi yang dikenal per perintah. Opsi tak dikenal DITOLAK, bukan diabaikan:
 * `check --file <bundle>` (salah ketik dari `--bundle`) sebelumnya diam-diam
 * memeriksa bundle default dan tetap exit 0 di cron — persis kegagalan senyap
 * yang ingin dicegah alat ini.
 */
const REFRESH_FLAGS = [
  'out',
  'meta',
  'sources',
  'mds-root',
  'mds-url',
  'mds-blob',
  'android-url',
  'android-file',
  'apple-url',
  'apple-file',
  'accept-new-mds-chain',
  'keep-expired',
  'dry-run',
];
const CHECK_FLAGS = ['bundle', 'meta', 'strict'];

function parseArgs(argv, allowed) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (allowed && !allowed.includes(key)) {
        throw new Error(`opsi tak dikenal: --${key} (opsi sah: ${allowed.map((k) => `--${k}`).join(', ')})`);
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i += 1;
      }
    } else {
      throw new Error(`argumen tak dikenal: ${arg}`);
    }
  }
  return opts;
}

function readOptional(path) {
  return path && existsSync(path) ? readFileSync(path, 'utf8') : null;
}

async function refresh(argv) {
  const opts = parseArgs(argv, REFRESH_FLAGS);
  const now = new Date();
  const out = resolve(opts.out && typeof opts.out === 'string' ? opts.out : DEFAULT_BUNDLE);
  const metaPath = resolve(opts.meta && typeof opts.meta === 'string' ? opts.meta : `${out}.meta.json`);
  const sources = String(opts.sources ?? 'mds,android,apple')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of sources) {
    if (!['mds', 'android', 'apple'].includes(name)) throw new Error(`sumber tak dikenal: ${name}`);
  }
  const keepExpired = opts['keep-expired'] === true;
  const previousMeta = (() => {
    const raw = readOptional(metaPath);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      console.warn(`⚠️  metadata lama tidak bisa dibaca sebagai JSON: ${metaPath} — pin rantai MDS dianggap belum ada.`);
      return null;
    }
  })();

  const candidates = [];
  const sourceReports = [];
  let mdsMeta = null;

  if (sources.includes('mds')) {
    const url = typeof opts['mds-url'] === 'string' ? opts['mds-url'] : MDS_URL;
    const blobFile = typeof opts['mds-blob'] === 'string' ? opts['mds-blob'] : null;
    const jwt = blobFile ? readFileSync(blobFile, 'utf8').trim() : (await fetchText(url)).trim();
    const pinnedRoots = typeof opts['mds-root'] === 'string' ? readCerts(opts['mds-root']) : [];
    const expectedHost = new URL(url).hostname;
    const { header, chain, chainFingerprints } = verifyJwsChain(jwt, { expectedHost, pinnedRoots, now });
    assertMdsChainContinuity({
      chainFingerprints,
      previousMeta,
      acceptNewChain: opts['accept-new-mds-chain'] === true,
    });

    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    const { candidates: mdsRoots, dropped: entryDrops } = mdsCandidates(payload);
    const filtered = filterRoots(mdsRoots, { now, keepExpired });
    candidates.push(...filtered.kept);
    sourceReports.push({
      name: 'fido-mds',
      url: blobFile ? `file:${blobFile}` : url,
      entries: (payload.entries ?? []).length,
      candidates: mdsRoots.length,
      kept: filtered.kept.length,
      dropped: { ...entryDrops, ...filtered.dropped },
      nextUpdate: payload.nextUpdate ?? null,
      serialNo: payload.no ?? null,
    });
    console.log(`✅ MDS ${blobFile ? blobFile : url}`);
    console.log(`   JWS ${header.alg} valid · rantai ${chain.length} sertifikat · nextUpdate ${payload.nextUpdate ?? '?'} · entri ${(payload.entries ?? []).length}`);
    console.log(`   kandidat ${mdsRoots.length} → disimpan ${filtered.kept.length} (bukan CA ${filtered.dropped.non_ca}, kedaluwarsa ${filtered.dropped.expired}, duplikat ${filtered.dropped.duplicate}, entri kompromi ${entryDrops.compromised_entry})`);

    mdsMeta = {
      url: blobFile ? `file:${blobFile}` : url,
      no: payload.no ?? null,
      nextUpdate: payload.nextUpdate ?? null,
      blobSha256: sha256Hex(jwt),
      rootPinned: pinnedRoots.length > 0,
      chain: chain.map((cert) => ({
        sha256: fingerprint(cert),
        subject: cert.subject.replace(/\n/g, ', '),
        validTo: new Date(cert.validTo).toISOString(),
      })),
    };
  }

  if (sources.includes('android')) {
    const url = typeof opts['android-url'] === 'string' ? opts['android-url'] : ANDROID_URL;
    const file = typeof opts['android-file'] === 'string' ? opts['android-file'] : null;
    const raw = file ? readFileSync(file, 'utf8') : await fetchText(url);
    const blocks = extractPemBlocks(raw);
    const filtered = filterRoots(blocks.map((pem) => ({ cert: new X509Certificate(pem), source: 'android' })), { now, keepExpired });
    candidates.push(...filtered.kept);
    sourceReports.push({
      name: 'android',
      url: file ? `file:${file}` : url,
      candidates: blocks.length,
      kept: filtered.kept.length,
      dropped: filtered.dropped,
    });
    console.log(`✅ Android ${file ? file : url}: kandidat ${blocks.length} → disimpan ${filtered.kept.length}`);
  }

  if (sources.includes('apple')) {
    const url = typeof opts['apple-url'] === 'string' ? opts['apple-url'] : APPLE_URL;
    const file = typeof opts['apple-file'] === 'string' ? opts['apple-file'] : null;
    const raw = file ? readFileSync(file, 'utf8') : await fetchText(url);
    const blocks = extractPemBlocks(raw);
    const filtered = filterRoots(blocks.map((pem) => ({ cert: new X509Certificate(pem), source: 'apple-webauthn' })), { now, keepExpired });
    candidates.push(...filtered.kept);
    sourceReports.push({
      name: 'apple-webauthn',
      url: file ? `file:${file}` : url,
      candidates: blocks.length,
      kept: filtered.kept.length,
      dropped: filtered.dropped,
    });
    console.log(`✅ Apple ${file ? file : url}: kandidat ${blocks.length} → disimpan ${filtered.kept.length}`);
  }

  // Dedup lintas sumber (root yang sama sering muncul di MDS dan di berkas vendor).
  const finalMap = new Map();
  let crossSourceDuplicates = 0;
  for (const entry of candidates) {
    if (finalMap.has(entry.fp)) {
      crossSourceDuplicates += 1;
      continue;
    }
    finalMap.set(entry.fp, entry);
  }
  const finalRoots = [...finalMap.values()].sort((a, b) => a.fp.localeCompare(b.fp));
  if (finalRoots.length === 0) throw new Error('tidak ada root yang lolos filter — bundle tidak ditulis');

  const pem = finalRoots.map((entry) => entry.cert.toString().trim()).join('\n') + '\n';
  const expiredKept = finalRoots.filter((entry) => new Date(entry.cert.validTo) <= now);
  const nextUpdate = sourceReports.find((report) => report.name === 'fido-mds')?.nextUpdate ?? null;

  const meta = {
    schema: 'nyx-attestation-roots/1',
    generatedAt: now.toISOString(),
    bundle: { path: out, sha256: sha256Hex(pem), certs: finalRoots.length },
    nextUpdate,
    mds: mdsMeta ?? null,
    sources: sourceReports,
    duplicatesAcrossSources: crossSourceDuplicates,
    certs: finalRoots.map((entry) => ({
      sha256: entry.fp,
      subject: entry.cert.subject.replace(/\n/g, ', '),
      validTo: new Date(entry.cert.validTo).toISOString(),
      source: entry.source,
      aaguid: entry.aaguid,
    })),
    warnings: [],
  };

  if (nextUpdate && daysUntil(nextUpdate, now) !== null && daysUntil(nextUpdate, now) < 0) {
    meta.warnings.push(`MDS nextUpdate sudah lewat (${nextUpdate}); daftar root mungkin tidak lengkap.`);
  }
  if (expiredKept.length > 0) {
    meta.warnings.push(
      `${expiredKept.length} root kedaluwarsa disimpan karena --keep-expired; sertifikat itu tidak bisa memverifikasi tanda tangan baru.`
    );
  }
  if (crossSourceDuplicates > 0) {
    meta.warnings.push(`${crossSourceDuplicates} root duplikat lintas sumber dibuang.`);
  }

  if (opts['dry-run'] === true) {
    console.log(`🧪 --dry-run: ${finalRoots.length} root akan ditulis ke ${out} (tidak ada berkas yang diubah)`);
  } else {
    writeFileSync(out, pem);
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    console.log(`✅ ${finalRoots.length} root ditulis ke ${out}`);
    console.log(`   metadata: ${metaPath}`);
  }
  if (nextUpdate) {
    const days = daysUntil(nextUpdate, now);
    console.log(
      days === null
        ? `   nextUpdate MDS: ${nextUpdate}`
        : `   nextUpdate MDS: ${nextUpdate} (${days >= 0 ? `${days} hari lagi` : `LEWAT ${Math.abs(days)} hari`})`
    );
  }
  for (const warning of meta.warnings) console.warn(`⚠️  ${warning}`);
  return 0;
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

function check(argv) {
  const opts = parseArgs(argv, CHECK_FLAGS);
  const bundlePath = resolve(opts.bundle && typeof opts.bundle === 'string' ? opts.bundle : DEFAULT_BUNDLE);
  const metaPath = resolve(opts.meta && typeof opts.meta === 'string' ? opts.meta : `${bundlePath}.meta.json`);
  const now = new Date();
  const warnings = [];
  const errors = [];

  if (!existsSync(bundlePath)) {
    console.error(`❌ bundle tidak ada: ${bundlePath}`);
    return 1;
  }
  const pem = readFileSync(bundlePath, 'utf8');
  const blocks = pem.match(PEM_BLOCK) ?? [];
  if (blocks.length === 0) {
    console.error(`❌ bundle tidak memuat sertifikat PEM: ${bundlePath}`);
    return 1;
  }
  const certs = blocks.map((block) => new X509Certificate(block));
  const expired = certs.filter((cert) => new Date(cert.validTo) <= now);
  const expiringSoon = certs.filter((cert) => {
    const days = (new Date(cert.validTo).getTime() - now.getTime()) / 86_400_000;
    return days > 0 && days <= 30;
  });
  const nonCa = certs.filter((cert) => !cert.ca);

  console.log(`📦 ${bundlePath}`);
  console.log(`   ${certs.length} root · mtime ${statSync(bundlePath).mtime.toISOString()}`);
  if (nonCa.length > 0) warnings.push(`${nonCa.length} entri bukan CA (basicConstraints) — tidak bisa membangun jalur.`);

  let meta = null;
  const rawMeta = readOptional(metaPath);
  if (!rawMeta) {
    warnings.push(
      `metadata tidak ada (${metaPath}): tanggal nextUpdate MDS tidak bisa diperiksa. Jalankan \`node scripts/attestation-roots.mjs refresh\`.`
    );
  } else {
    try {
      meta = JSON.parse(rawMeta);
    } catch {
      warnings.push(`metadata tidak bisa dibaca sebagai JSON: ${metaPath}`);
    }
  }

  if (meta) {
    const recorded = meta.bundle?.sha256;
    if (recorded && recorded !== sha256Hex(pem)) {
      warnings.push(
        'bundle berbeda dari yang dicatat metadata (diganti manual/di-edit): nextUpdate dan pin rantai MDS di metadata TIDAK menggambarkan isi bundle ini.'
      );
    }
    if (meta.nextUpdate) {
      const days = daysUntil(meta.nextUpdate, now);
      if (days === null) {
        warnings.push(`nextUpdate MDS di metadata tidak bisa dibaca: ${meta.nextUpdate}`);
      } else if (days < 0) {
        warnings.push(
          `bundle melewati nextUpdate MDS (${meta.nextUpdate}, ${Math.abs(days)} hari lalu): segarkan dengan \`refresh\`; perangkat baru bisa ditolak reason=root_not_trusted.`
        );
      } else {
        console.log(`   nextUpdate MDS: ${meta.nextUpdate} (${days} hari lagi)`);
      }
    } else {
      warnings.push('metadata tidak memuat nextUpdate MDS — sumber refresh bukan MDS atau refresh dijalankan tanpa sumber MDS.');
    }
  }

  if (expired.length > 0) {
    warnings.push(`${expired.length} root sudah kedaluwarsa (mis. ${expired[0].subject.replace(/\n/g, ', ')} — ${expired[0].validTo}).`);
  }
  if (expiringSoon.length > 0) {
    warnings.push(`${expiringSoon.length} root kedaluwarsa dalam 30 hari (paling cepat ${expiringSoon[0].validTo}).`);
  }

  if (warnings.length === 0) {
    console.log('✅ bundle sehat: metadata ada, belum melewati nextUpdate, tidak ada root kedaluwarsa.');
    return 0;
  }
  for (const warning of warnings) console.warn(`⚠️  ${warning}`);
  return opts.strict === true ? 2 : 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'inspect' && rest.length > 0) {
    inspect(rest);
    return 0;
  }
  if (command === 'bundle') {
    const outIndex = rest.indexOf('--out');
    const out = outIndex >= 0 ? rest[outIndex + 1] : undefined;
    const inputs = rest.filter((_, index) => index !== outIndex && index !== outIndex + 1);
    if (!out || inputs.length === 0) {
      console.error(USAGE);
      return 2;
    }
    bundle(inputs, out);
    return 0;
  }
  if (command === 'refresh') return refresh(rest);
  if (command === 'check') return check(rest);
  console.error(USAGE);
  return 2;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
