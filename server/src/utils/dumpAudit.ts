// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 3.2] Dump simulator — logika analisis (murni, tanpa DB).
 *
 * Tujuan: mengubah klaim privasi at-rest dari *argumen* menjadi **bukti**.
 * Alur (`scripts/privacy-dump-audit.ts`): seed DB lokal → `pg_dump` → fungsi di
 * sini memeriksa dump dan melaporkan apakah identitas asli benar-benar tidak
 * ada di kolom-kolom yang seharusnya ter-seal/tag/hash.
 *
 * Modul ini SENGAJA tidak menyentuh DB/Redis: ia hanya mem-parsing teks dump
 * (format plain `pg_dump`) + daftar nilai rahasia yang diharapkan tidak muncul.
 * Dengan begitu ia bisa diuji dengan fixture (tanpa Postgres), dan script nyata
 * hanya jadi pembungkus tipis.
 *
 * Yang diperiksa (adversary A1 = pencuri dump):
 *  - label device, anchor instalasi, endpoint push,
 *  - keanggotaan (`UserHiddenConversation.userId`), penulis story, block,
 *  - sender 1:1 (`Message.senderId` NULL) & receipt (`MessageStatus.userId` tag),
 *  - reply edge (`Message.repliedToId` ter-seal),
 *  - rahasia otoritas (`authSecret`/`deleteSecret`) berbentuk hash,
 *  - Redis (key + member SET) tidak memuat userId asli.
 */

import {
  DERIVED_TIME_MODELS,
  TEMPORAL_BUCKETS,
  TEMPORAL_EXCEPTIONS,
} from '../lib/temporalBuckets.js';

export interface CopySection {
  table: string;
  columns: string[];
  rows: string[][];
}

export interface DumpAuditContext {
  /** userId asli yang di-seed — TIDAK boleh muncul di kolom identitas mana pun. */
  userIds?: string[];
  /** id pesan asli (reply edge harus ter-seal, bukan plaintext). */
  messageIds?: string[];
  /** label device yang di-set klien (harus ter-seal). */
  deviceNames?: string[];
  /** endpoint FCM/APNs (harus ter-seal). */
  pushEndpoints?: string[];
}

export interface AuditFinding {
  rule: string;
  ok: boolean;
  detail: string;
}

/** Kolom yang SECARA DESAIN tidak boleh memuat nilai rahasia apa adanya. */
const IDENTITY_TARGETS: ReadonlyArray<{
  table: string;
  column: string;
  secrets: keyof DumpAuditContext;
  label: string;
}> = [
  { table: 'MessageStatus', column: 'userId', secrets: 'userIds', label: 'receipt (tag per-conversation)' },
  { table: 'UserHiddenConversation', column: 'userId', secrets: 'userIds', label: 'keanggotaan (routing identity ter-seal)' },
  { table: 'Message', column: 'senderId', secrets: 'userIds', label: 'sender (NULL di 1:1 / pseudonym grup v2)' },
  { table: 'Story', column: 'authorTag', secrets: 'userIds', label: 'penulis story (ter-seal)' },
  { table: 'BlockedUser', column: 'blockerTag', secrets: 'userIds', label: 'block edge (ter-seal)' },
  { table: 'BlockedUser', column: 'blockedTag', secrets: 'userIds', label: 'block edge (ter-seal)' },
  { table: 'Device', column: 'nameSealed', secrets: 'deviceNames', label: 'label device (ter-seal)' },
  { table: 'Device', column: 'installationTag', secrets: 'deviceNames', label: 'anchor instalasi (tag HMAC)' },
  { table: 'PushSubscription', column: 'endpointSealed', secrets: 'pushEndpoints', label: 'endpoint push (ter-seal)' },
  // Nama kolom HARUS nama kolom DB (`pg_dump` menulis skema, bukan field Prisma):
  // `Message.repliedToId` di schema.prisma di-`@map("replied_to_id")`. Memakai
  // nama field Prisma di sini membuat pemeriksaan reply edge VAKUM (kolom tidak
  // pernah ketemu) — lihat guard `hasColumn` di bawah.
  { table: 'Message', column: 'replied_to_id', secrets: 'messageIds', label: 'reply edge (ter-seal)' },
];

/** Batas hash SHA-256 hex (pola `adminSecretHash`). */
const HEX64_RE = /^[a-f0-9]{64}$/;

function unquote(identifier: string): string {
  const trimmed = identifier.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Parse section `COPY ... FROM stdin;` dari output plain `pg_dump`.
 *
 * Format baris: nilai dipisah TAB, `\N` = NULL, escape `\\`, `\t`, `\n`, `\r`.
 * Untuk perbandingan identitas kita butuh nilai yang sudah di-unescape.
 */
export function parseCopySections(dump: string): CopySection[] {
  const sections: CopySection[] = [];
  // Terminator `\.` HARUS di-anchor ke awal baris (`^\\.`, flag `m`), bukan
  // `\n\\\.`. Alasannya: untuk tabel KOSONG urutannya persis
  // `FROM stdin;\n\\.\n`, sehingga pola lama (`\n` terminator) tidak menemukan
  // baris penutup dan body-nya menelan blok tabel BERIKUTNYA — tabel berikut itu
  // lalu tidak pernah di-audit (audit tetap hijau padahal ada kebocoran).
  const copyRe = /^COPY\s+(?:[^\s()]+\.)?"?([\w]+)"?\s*\(([^)]*)\)\s+FROM stdin;\r?\n([\s\S]*?)^\\\.[ \t]*\r?$/gm;
  let match: RegExpExecArray | null;
  while ((match = copyRe.exec(dump)) !== null) {
    const table = match[1]!;
    const columns = match[2]!.split(',').map(unquote);
    // Terminator di-anchor ke `^`, jadi baris penutup tidak ikut terpotong —
    // buang satu newline di ujung body supaya tidak jadi baris kosong palsu.
    const body = match[3]!.replace(/\r?\n$/, '');
    const rows = body.length === 0
      ? []
      : body.split('\n').map((line) => line.split('\t').map(unescapePgValue));
    sections.push({ table, columns, rows });
  }
  return sections;
}

/** Balikkan escape nilai COPY PostgreSQL ke teks aslinya. */
export function unescapePgValue(value: string): string {
  if (value === '\\N') return '\0NULL\0';
  return value
    .replace(/\\\\/g, '\\')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r');
}

/** Semua nilai satu kolom dari tabel tertentu (case-sensitive nama tabel). */
export function columnValues(sections: CopySection[], table: string, column: string): string[] {
  const values: string[] = [];
  for (const section of sections) {
    if (section.table !== table) continue;
    const index = section.columns.indexOf(column);
    if (index === -1) continue;
    for (const row of section.rows) {
      const value = row[index];
      if (typeof value === 'string' && value !== '\0NULL\0') values.push(value);
    }
  }
  return values;
}

/**
 * Apakah tabel+kolom benar-benar ada di dump? Dipakai sebagai guard anti-vakum:
 * audit yang "lulus" karena kolomnya tidak ketemu adalah lebih buruk daripada
 * audit yang gagal terang-terangan.
 */
export function hasColumn(sections: CopySection[], table: string, column: string): boolean {
  return sections.some((section) => section.table === table && section.columns.includes(column));
}

/** Nilai-nilai yang ada di kolom `table.column` DAN termasuk daftar rahasia. */
export function leakedSecrets(
  sections: CopySection[],
  table: string,
  column: string,
  secrets: string[]
): string[] {
  if (secrets.length === 0) return [];
  const secretSet = new Set(secrets);
  return columnValues(sections, table, column).filter((value) => secretSet.has(value));
}

/** Periksa seluruh kolom identitas terhadap dump + daftar rahasia. */
export function auditDumpForIdentityLeaks(dump: string, ctx: DumpAuditContext): AuditFinding[] {
  const sections = parseCopySections(dump);
  const findings: AuditFinding[] = [];

  if (sections.length === 0) {
    findings.push({
      rule: 'dump-parseable',
      ok: false,
      detail: 'tidak ada section COPY yang terbaca — dump kosong atau format tabel (`pg_dump --table`) tidak cocok',
    });
    return findings;
  }

  for (const target of IDENTITY_TARGETS) {
    // Anti-vakum: kalau kolomnya tidak ada di dump, jangan klaim "aman".
    if (!hasColumn(sections, target.table, target.column)) {
      findings.push({
        rule: `${target.table}.${target.column}`,
        ok: false,
        detail: `${target.label}: kolom ${target.table}.${target.column} tidak ada di dump — TIDAK BISA diverifikasi (nama kolom/format dump berubah?)`,
      });
      continue;
    }
    const secrets = ctx[target.secrets] ?? [];
    const leaks = leakedSecrets(sections, target.table, target.column, secrets);
    findings.push({
      rule: `${target.table}.${target.column}`,
      ok: leaks.length === 0,
      detail:
        leaks.length === 0
          ? `${target.label}: tidak ada nilai rahasia (${secrets.length} nilai dicek)`
          : `${target.label}: ${leaks.length} identitas BOCOR apa adanya di dump`,
    });
  }

  // Rahasia otoritas: bila ada nilainya, WAJIB berbentuk hash SHA-256 64-hex.
  // [2026-10 legacy purge] Dulu nilai plaintext (baris pra-hash) diloloskan
  // supaya migrasi tidak merah; sekarang tidak ada baris seperti itu.
  for (const [table, column] of [
    ['Conversation', 'authSecret'],
    ['Message', 'deleteSecret'],
  ] as const) {
    if (!hasColumn(sections, table, column)) {
      findings.push({
        rule: `${table}.${column}-hashed`,
        ok: false,
        detail: `${table}.${column}: kolom tidak ada di dump — TIDAK BISA diverifikasi`,
      });
      continue;
    }
    const values = columnValues(sections, table, column);
    const notHashed = values.filter((v) => !HEX64_RE.test(v));
    findings.push({
      rule: `${table}.${column}-hashed`,
      ok: notHashed.length === 0,
      detail:
        notHashed.length === 0
          ? `${table}.${column}: ${values.length} nilai, semua hash (atau kosong)`
          : `${table}.${column}: ${notHashed.length}/${values.length} nilai bukan hash SHA-256`,
    });
  }

  return findings;
}

/** Pola timestamp `pg_dump`/PostgreSQL: `2026-11-17 10:00:00+00`, `…-07`, `…Z`. */
const DUMP_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([+-])(\d{2})(?::?(\d{2}))?|Z)?$/;

/**
 * [docs/43 §43.16.4 R9] Ubah nilai kolom timestamp `pg_dump` ke epoch milidetik.
 *
 * Offset zona waktu dihormati (`+00`, `+0530`, `Z`) karena bucket 15 menit di
 * `temporalBuckets.ts` dihitung dari epoch UTC: mengabaikan offset akan membuat
 * dump dari host non-UTC terlihat "tidak ter-bucket" padahal benar.
 */
export function parseDumpTimestamp(value: string): number | null {
  const trimmed = value.trim();
  const match = DUMP_TIMESTAMP_RE.exec(trimmed);
  if (!match) return null;
  const fraction = (match[7] ?? '0').padEnd(3, '0').slice(0, 3);
  let epoch = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(fraction)
  );
  if (match[8]) {
    const offsetMs = (Number(match[9]) * 60 + Number(match[10] ?? '0')) * 60_000;
    epoch -= (match[8] === '-' ? -1 : 1) * offsetMs;
  }
  return epoch;
}

/**
 * [docs/43 §43.16.4 R9] Buktikan klaim bucket waktu lewat DUMP, bukan bacaan
 * manual: setiap kolom di `TEMPORAL_BUCKETS` yang muncul di dump harus berisi
 * nilai yang jatuh tepat di batas bucket-nya.
 *
 * Kolom yang TIDAK ada di dump dilaporkan gagal (anti-vakum) — sama seperti
 * pemeriksaan identitas: audit yang hijau karena kolomnya tidak ketemu lebih
 * buruk daripada audit yang gagal terang-terangan. Tabel yang tidak ada sama
 * sekali dilewati, karena `pg_dump --table` memang bisa memilih sebagian tabel.
 */
export function auditTemporalBuckets(sections: CopySection[], now: Date = new Date()): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const tables = new Set(sections.map((section) => section.table));

  for (const [model, fields] of Object.entries(TEMPORAL_BUCKETS)) {
    if (!tables.has(model)) continue;
    const exceptions = TEMPORAL_EXCEPTIONS[model] ?? {};
    for (const { field, bucketMs } of fields) {
      const rule = `${model}.${field}`;
      if (exceptions[field]) {
        findings.push({ rule: `${rule}-bucket`, ok: true, detail: `pengecualian tercatat: ${exceptions[field]}` });
        continue;
      }
      if (!hasColumn(sections, model, field)) {
        findings.push({
          rule: `${rule}-bucket`,
          ok: false,
          detail: `kolom ${model}.${field} tidak ada di dump — TIDAK BISA diverifikasi`,
        });
        continue;
      }
      const values = columnValues(sections, model, field);
      const unparsed = values.filter((value) => parseDumpTimestamp(value) === null);
      const misaligned = values.filter((value) => {
        const epoch = parseDumpTimestamp(value);
        return epoch !== null && epoch % bucketMs !== 0;
      });
      if (unparsed.length > 0) {
        findings.push({
          rule: `${rule}-bucket`,
          ok: false,
          detail: `${unparsed.length}/${values.length} nilai timestamp tidak terbaca: ${unparsed.slice(0, 2).join(', ')}`,
        });
        continue;
      }
      findings.push({
        rule: `${rule}-bucket`,
        ok: misaligned.length === 0,
        detail:
          misaligned.length === 0
            ? `${values.length} nilai, semua di batas bucket ${bucketMs / 60_000} menit`
            : `${misaligned.length}/${values.length} nilai TIDAK di batas bucket ${bucketMs / 60_000} menit (presisi waktu bocor)`,
      });
    }
  }

  // Model turunan (`Message`, `Story`) menurunkan `expiresAt` dari waktu yang
  // sudah dipotong di route; kalau suatu saat model itu masuk peta bucket,
  // bucket ganda akan memisahkan `createdAt` dari `expiresAt`.
  for (const model of DERIVED_TIME_MODELS) {
    findings.push({
      rule: `${model}-derived-time`,
      ok: !(model in TEMPORAL_BUCKETS),
      detail:
        model in TEMPORAL_BUCKETS
          ? `model turunan ${model} masuk TEMPORAL_BUCKETS — bucket ganda memisahkan createdAt dari expiresAt`
          : `waktu ${model} diturunkan di route (tidak di-bucket ganda); diperiksa di ${now.toISOString().slice(0, 10)}`,
    });
  }

  return findings;
}

/**
 * [docs/43 §43.16.4 R1] Kolom yang MEMANG memuat userId asli menurut desain:
 *   - `User.id` — baris akun itu sendiri (bukan edge);
 *   - `Device.userId` — routing perangkat → akun, residual R1 yang tercatat.
 *
 * Kolom lain yang memuat userId asli adalah kebocoran yang tidak
 * didokumentasikan — termasuk kolom baru yang lupa di-seal.
 */
export const RESIDUAL_USER_ID_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'User', column: 'id' },
  { table: 'Device', column: 'userId' },
];

/**
 * [docs/43 §43.16.4 R9] Cari userId asli di SELURUH kolom dump, lalu izinkan
 * hanya di kolom residual yang tercatat. Ini menangkap kolom baru yang memuat
 * userId tanpa disadari — pemeriksaan identitas di atas hanya mengenali kolom
 * yang sudah terdaftar.
 */
export function auditResidualPlaintextEdges(sections: CopySection[], userIds: string[]): AuditFinding[] {
  if (userIds.length === 0) {
    return [{
      rule: 'residual-edges',
      ok: true,
      detail: 'tidak ada userId acuan yang di-seed — pemeriksaan edge residual dilewati',
    }];
  }
  const allowed = new Set(RESIDUAL_USER_ID_COLUMNS.map(({ table, column }) => `${table}.${column}`));
  const unexpected: string[] = [];
  for (const section of sections) {
    for (const column of section.columns) {
      if (allowed.has(`${section.table}.${column}`)) continue;
      const leaks = leakedSecrets(sections, section.table, column, userIds);
      if (leaks.length > 0) unexpected.push(`${section.table}.${column}`);
    }
  }
  return [{
    rule: 'residual-edges',
    ok: unexpected.length === 0,
    detail:
      unexpected.length === 0
        ? `userId asli hanya muncul di edge residual yang tercatat (${[...allowed].join(', ')}); ${sections.length} tabel diperiksa`
        : `userId asli muncul di kolom yang TIDAK tercatat sebagai residual: ${unexpected.slice(0, 5).join(', ')}`,
  }];
}

/**
 * Satu pintu audit untuk skrip: identitas + bucket waktu + edge residual.
 * Dipisah dari `auditDumpForIdentityLeaks` supaya fixture lama tetap sah, tetapi
 * skrip nyata memakai versi lengkap ini.
 */
export function auditDumpComprehensive(dump: string, ctx: DumpAuditContext): AuditFinding[] {
  const sections = parseCopySections(dump);
  return [
    ...auditDumpForIdentityLeaks(dump, ctx),
    ...auditTemporalBuckets(sections),
    ...auditResidualPlaintextEdges(sections, ctx.userIds ?? []),
  ];
}

/** Periksa artefak Redis: key & member SET tidak boleh memuat userId asli. */
export function auditRedisArtifacts(keys: string[], members: string[], userIds: string[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const leakyKeys = keys.filter((key) => userIds.some((id) => key.includes(id)));
  findings.push({
    rule: 'redis.key-names',
    ok: leakyKeys.length === 0,
    detail:
      leakyKeys.length === 0
        ? `${keys.length} key Redis diperiksa, tidak ada yang memuat userId`
        : `${leakyKeys.length} key Redis memuat userId asli: ${leakyKeys.slice(0, 3).join(', ')}`,
  });

  const leakyMembers = members.filter((member) => userIds.includes(member));
  findings.push({
    rule: 'redis.set-members',
    ok: leakyMembers.length === 0,
    detail:
      leakyMembers.length === 0
        ? `${members.length} member SET diperiksa, tidak ada userId asli`
        : `${leakyMembers.length} member SET adalah userId asli`,
  });

  return findings;
}

export function auditPassed(findings: AuditFinding[]): boolean {
  return findings.every((f) => f.ok);
}

export function formatAuditReport(findings: AuditFinding[]): string {
  const lines = findings.map((f) => `${f.ok ? '✅' : '❌'} ${f.rule}: ${f.detail}`);
  lines.push(auditPassed(findings) ? '\n✅ DUMP AUDIT LULUS' : '\n❌ DUMP AUDIT GAGAL — identitas terbaca dari dump');
  return lines.join('\n');
}
