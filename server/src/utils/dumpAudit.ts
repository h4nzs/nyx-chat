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
 *  - identitas B2B, label device, anchor instalasi, endpoint push,
 *  - keanggotaan (`UserHiddenConversation.userId`), penulis story, block,
 *  - sender 1:1 (`Message.senderId` NULL) & receipt (`MessageStatus.userId` tag),
 *  - reply edge (`Message.repliedToId` ter-seal),
 *  - rahasia otoritas (`authSecret`/`deleteSecret`) berbentuk hash,
 *  - Redis (key + member SET) tidak memuat userId asli.
 */

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
  /** externalId B2B dari tenant (harus ter-seal). */
  externalIds?: string[];
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
  { table: 'User', column: 'externalIdSealed', secrets: 'externalIds', label: 'identitas B2B (ter-seal)' },
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
