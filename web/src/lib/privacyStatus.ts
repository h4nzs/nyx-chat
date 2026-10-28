// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * Status lapisan privasi untuk panel "Privacy Self-Check".
 *
 * Aturan penting: panel ini **tidak boleh** menyatakan sesuatu "aktif" hanya
 * karena sebuah flag env disetel. Tiga tingkat bukti yang dipakai:
 *
 *   - `active`     — ada bukti nyata di perangkat (mis. state KT tersimpan dari
 *                    verifikasi yang benar-benar lolos).
 *   - `configured` — jalur hidup dan akan dipakai, tetapi belum ada bukti
 *                    round-trip yang tersimpan. Ditampilkan sebagai
 *                    "dikonfigurasi", bukan "terbukti".
 *   - `off`        — saklar mematikan lapisan itu (atau konfigurasinya mustahil).
 *   - `unknown`    — belum ada data/ belum pernah berjalan.
 *
 * Membuat panel ini jujur adalah intinya: klaim privasi yang tidak bisa
 * dibuktikan lebih berbahaya daripada tidak ada panel sama sekali.
 */

export type PrivacyLayerId = 'e2ee' | 'ratchet' | 'ohttp' | 'search' | 'kt';

export type PrivacyEvidence = 'active' | 'configured' | 'off' | 'unknown';

export interface PrivacyLayerStatus {
  id: PrivacyLayerId;
  state: PrivacyEvidence;
  /** Angka pendukung untuk ditampilkan (bukan identitas apa pun). */
  params?: Record<string, string | number>;
}

export interface PrivacyKtEvidence {
  /** Jumlah search key yang punya bukti tersimpan. */
  monitoredKeys: number;
  /** Tree size terbesar yang pernah diverifikasi. */
  treeSize?: number;
  /** Waktu verifikasi terakhir (epoch ms). */
  verifiedAt?: number;
}

export interface PrivacyStatusInput {
  /** `spqrSendingEnabled()`: klien mengiklankan & mengirim ratchet v2. */
  ratchetSending: boolean;
  ohttp: boolean;
  oprf: boolean;
  pir: boolean;
  kt?: PrivacyKtEvidence | null;
  /** Untuk test; default `Date.now()`. */
  now?: number;
}

/** Ambang "bukti masih segar" untuk ditampilkan di UI (tidak mengubah state). */
export const KT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Susun daftar status dari sumber yang sudah dikumpulkan. Fungsi murni: semua
 * I/O ada di `collectPrivacyStatus`, jadi aturan di sini bisa diuji tanpa Dexie.
 */
export function buildPrivacyStatus(input: PrivacyStatusInput): PrivacyLayerStatus[] {
  const statuses: PrivacyLayerStatus[] = [
    // Enkripsi pesan tidak punya saklar: klien selalu menyegel dan server hanya
    // meneruskan ciphertext. Karena itu `active` bukan klaim marketing.
    { id: 'e2ee', state: 'active' },
  ];

  statuses.push({
    id: 'ratchet',
    state: input.ratchetSending ? 'active' : 'off',
  });

  statuses.push({
    id: 'ohttp',
    // Tidak ada bukti round-trip tersimpan; jangan lebih tinggi dari ini.
    state: input.ohttp ? 'configured' : 'off',
  });

  // PIR tanpa OPRF mustahil (server menolak PIR_REQUIRES_OPRF) — konfigurasi
  // seperti itu bukan "aktif", melainkan rusak dan harus terlihat.
  const searchState: PrivacyEvidence = input.pir && !input.oprf
    ? 'off'
    : input.oprf
      ? 'configured'
      : 'off';
  statuses.push({
    id: 'search',
    state: searchState,
    params: { pir: input.pir ? 1 : 0, oprf: input.oprf ? 1 : 0 },
  });

  const kt = input.kt;
  if (!kt || kt.monitoredKeys <= 0) {
    statuses.push({ id: 'kt', state: 'unknown' });
  } else {
    const now = input.now ?? Date.now();
    statuses.push({
      id: 'kt',
      state: 'active',
      params: {
        keys: kt.monitoredKeys,
        ...(kt.treeSize !== undefined ? { treeSize: kt.treeSize } : {}),
        ...(kt.verifiedAt !== undefined ? { ageMs: Math.max(0, now - kt.verifiedAt) } : {}),
      },
    });
  }

  return statuses;
}

export interface PrivacyStatusDeps {
  ratchetSending?: () => boolean;
  ohttpEnabled?: () => boolean;
  oprfEnabled?: () => boolean;
  pirEnabled?: () => boolean;
  loadKt?: () => Promise<PrivacyKtEvidence | null>;
  now?: () => number;
}

/** Kumpulkan bukti nyata (Dexie + saklar runtime) lalu susun status. */
export async function collectPrivacyStatus(
  deps: PrivacyStatusDeps = {}
): Promise<PrivacyLayerStatus[]> {
  const ratchetSending =
    deps.ratchetSending ?? (await import('./spqrNegotiation')).spqrSendingEnabled;
  const ohttpEnabled = deps.ohttpEnabled ?? (await import('./ohttpClient')).ohttpEnabled;
  const oprfEnabled =
    deps.oprfEnabled ?? (await import('./searchOprfClient')).oprfSearchEnabled;
  const pirEnabled = deps.pirEnabled ?? (await import('./pirClient')).pirEnabled;
  const loadKt = deps.loadKt ?? loadKtEvidence;

  return buildPrivacyStatus({
    ratchetSending: ratchetSending(),
    ohttp: ohttpEnabled(),
    oprf: oprfEnabled(),
    pir: pirEnabled(),
    kt: await loadKt(),
    now: (deps.now ?? Date.now)(),
  });
}

/**
 * Bukti KT dari IndexedDB: berapa search key yang punya tree head tersimpan,
 * tree size terbesar, dan kapan terakhir ditulis. Nilai `updatedAt` ter-seal,
 * jadi dibuka lewat `decryptValueAtRest` (tidak pernah ditampilkan mentah).
 */
async function loadKtEvidence(): Promise<PrivacyKtEvidence | null> {
  try {
    const [{ db }, { decryptValueAtRest }, { loadKtStates }] = await Promise.all([
      import('./db'),
      import('./keychainDb'),
      import('./ktMonitoring'),
    ]);
    const states = await loadKtStates();
    const withProof = states.filter((state) => state.treeHead !== undefined);
    if (withProof.length === 0) return null;

    const records = await db.ktMonitoring.toArray();
    let verifiedAt: number | undefined;
    for (const record of records) {
      const plain = await decryptValueAtRest(record.updatedAt).catch(() => null);
      const parsed = plain ? Date.parse(plain) : Number.NaN;
      if (Number.isFinite(parsed) && (verifiedAt === undefined || parsed > verifiedAt)) {
        verifiedAt = parsed;
      }
    }

    const treeSize = withProof.reduce<number | undefined>(
      (max, state) => (state.treeSize !== undefined && (max === undefined || state.treeSize > max)
        ? state.treeSize
        : max),
      undefined
    );

    return { monitoredKeys: withProof.length, treeSize, verifiedAt };
  } catch {
    // IndexedDB tidak tersedia (mis. mode privat) — panel harus tetap tampil.
    return null;
  }
}
