// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.8 / docs/33 §33.7 poin 2–3] Negosiasi versi ratchet untuk jalur
 * SPQR (braid ML-KEM) vs DR hybrid NYX yang beku.
 *
 * Kenapa keputusan versi dipisah jadi modul murni: peralihan ke v2 menyentuh
 * **format wire beku** (`docs/04`), dan kesalahan yang paling mahal bukan
 * kripto-nya, melainkan **state transisi**: sesi yang tiba-tiba dianggap v1
 * padahal state braid-nya sudah dipakai (pesan tak terbaca), atau sebaliknya
 * sesi v1 lama dipaksa v2 hanya karena peer mengiklankan kapabilitas.
 *
 * Aturan yang dikodekan di sini:
 *
 *  1. **Kapabilitas hanya dibaca saat sesi DIDIRIKAN.** Percakapan yang sudah
 *     berjalan tidak berubah versi karena kabar kapabilitas yang datang
 *     belakangan (kapabilitas datang dari handshake transport yang
 *     terautentikasi, bukan dari payload pesan — payload pesan tidak sah untuk
 *     memutuskan primitif).
 *  2. **Anti-downgrade.** v2 hanya dipakai bila KEDUA sisi mengiklankan
 *     `spqr-ratchet` **dan** saklar lokal menyala. Peer yang tidak mengiklankan
 *     → v1 (kompatibel penuh), bukan "coba v2 dan berharap".
 *  3. **Rollback eksplisit.** Turun dari v2 ke v1 hanya lewat `planRatchetRollback`
 *     (dipanggil sadar oleh pemanggil), dan state v1 **tidak pernah ditimpa**
 *     oleh v2 — itulah yang membuat rollback tidak menghilangkan kemampuan
 *     membaca pesan lama (`docs/33` §33.8).
 *  4. **Idempoten.** Memanggil `resolveRatchetVersion` berulang dengan masukan
 *     yang sama menghasilkan keputusan yang sama; tidak ada efek samping.
 *
 * Saklar `SPQR_INTEGRATION_ENABLED` kini **menyala**: jalur v2 (`spqrWire.ts`,
 * `spqrSession.ts`, op worker `spqr_ratchet_*`, state ter-seal `spqrState.ts`)
 * sudah ada beserta versi wire + deklarasi versi in-band. Kill switch operator:
 * `VITE_SPQR_FORCE_V1=1` (mengembalikan semua pengiriman ke v1; state braid
 * TIDAK dihapus sehingga pesan v2 yang sudah lewat tetap terbaca).
 *
 * **v2 tidak pernah dipilih hanya dari kapabilitas.** Kapabilitas transport
 * hanya menyatakan "deployment ini bisa melewatkan frame v2"; yang menentukan
 * adalah deklarasi peer di dalam payload ter-seal (`ackV`, `docs/04`). Peer
 * yang belum menyatakan mampu → jalur v1, tanpa terkecuali: itulah yang membuat
 * klien lama tidak pernah menerima header v2 yang tidak bisa dibacanya.
 */

import { CLIENT_CAPABILITIES } from '@nyx/shared';

/** Versi wire ratchet: v1 = DR hybrid NYX (beku), v2 = DR + braid SPQR. */
export type RatchetWireVersion = 'v1' | 'v2';

/**
 * Nama kapabilitas saat pertukaran hello transport. Diambil dari
 * `@nyx/shared` (satu sumber dengan sidecar/klien lain) — bukan literal lokal,
 * supaya klien tidak bisa menyimpang dari konstanta yang diuji paritasnya.
 */
export const SPQR_CAPABILITY: string = CLIENT_CAPABILITIES.SPQR_RATCHET;

/**
/**
 * Saklar operator: matikan jalur v2 sepenuhnya (kirim selalu v1).
 *
 * Hanya untuk keadaan darurat (mis. bug pada modul WASM menemukan masalah di
 * lapangan). Mematikannya **tidak** menghapus state braid, jadi pesan v2 yang
 * sudah terkirim tetap bisa dibuka lewat jalur inbound.
 */
export function resolveSpqrIntegrationEnabled(
  env: { VITE_SPQR_FORCE_V1?: string } = import.meta.env as { VITE_SPQR_FORCE_V1?: string }
): boolean {
  return env.VITE_SPQR_FORCE_V1 !== '1';
}

/**
 * Override uji/E2E: perlakukan kapabilitas transport `spqr-ratchet` seolah
 * dinegosiasikan. Hanya dihormati di build DEV (`import.meta.env.DEV`) — tanpa
 * ini, jalur v2 tidak bisa diuji di mesin tanpa sidecar WebTransport (fallback
 * WSS tidak pernah menegosiasikan kapabilitas), dan di produksi ia tidak akan
 * pernah berpengaruh.
 */
export function resolveSpqrCapabilityOverride(
  env: { DEV?: boolean; VITE_SPQR_FORCE_V2?: string } = import.meta.env as {
    DEV?: boolean;
    VITE_SPQR_FORCE_V2?: string;
  }
): boolean {
  return env.DEV === true && env.VITE_SPQR_FORCE_V2 === '1';
}

/**
 * Saklar integrasi efektif: apakah klien ini boleh **menerima & mengirim** v2.
 * Dimatikan hanya lewat kill switch operator.
 */
export const SPQR_INTEGRATION_ENABLED = resolveSpqrIntegrationEnabled();

/** Override kapabilitas uji/E2E (lihat `resolveSpqrCapabilityOverride`). */
export const SPQR_CAPABILITY_OVERRIDE = resolveSpqrCapabilityOverride();

/**
 * Kunci `localStorage` untuk kill switch **runtime** (khusus build DEV).
 *
 * Kenapa ada jalur runtime: `VITE_SPQR_FORCE_V1` adalah env build-time, jadi
 * seluruh klien dari satu build punya nilai yang sama — artinya **rollback v2→v1
 * pada satu klien di tengah sesi tidak bisa diuji E2E sama sekali** (dua klien
 * selalu sependapat soal saklar). Dengan override ini, satu klien bisa dipaksa
 * kembali ke v1 setelah jalur v2-nya berdiri, dan hasilnya dibuktikan dari
 * amplop nyata di server (`web/e2e/spqr.spec.ts`).
 */
export const SPQR_RUNTIME_KILL_SWITCH_KEY = 'nyx_spqr_force_v1';

/**
 * Kill switch runtime — **hanya dihormati di build DEV**.
 *
 * Di produksi (`import.meta.env.DEV === false`) fungsi ini selalu `false`,
 * sehingga tidak ada apa pun yang bisa mematikan jalur v2 dari halaman (XSS di
 * origin yang sama tidak mendapat kenop tambahan). Dibaca **per keputusan**, bukan
 * sekali saat modul dimuat, supaya rollback benar-benar berlaku pada pengiriman
 * berikutnya tanpa reload — persis yang diuji E2E.
 */
export function resolveSpqrRuntimeKillSwitch(
  env: { DEV?: boolean } = import.meta.env as { DEV?: boolean },
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage
): boolean {
  if (env.DEV !== true || !storage) return false;
  return storage.getItem(SPQR_RUNTIME_KILL_SWITCH_KEY) === '1';
}

/**
 * Apakah klien ini boleh **mengirim & mengiklankan** jalur v2 *saat ini*:
 * saklar build-time (`VITE_SPQR_FORCE_V1`) DAN kill switch runtime (DEV).
 *
 * Dipakai di tiap pengiriman dan saat mengiklankan kapabilitas. **Tidak** dipakai
 * untuk menolak pesan v2 yang masuk: rollback operator tidak boleh mengubah
 * pesan yang sudah terkirim menjadi tak terbaca (state braid tetap dipertahankan,
 * lihat `decryptSpqrMessage`).
 */
export function spqrSendingEnabled(): boolean {
  return SPQR_INTEGRATION_ENABLED && !resolveSpqrRuntimeKillSwitch();
}

export type RatchetVersionReason =
  | 'established'
  | 'both-capable'
  | 'local-disabled'
  | 'peer-legacy'
  | 'rollback';

export interface RatchetNegotiationInput {
  /** Kapabilitas hasil negosiasi transport (`negotiateCapabilities`). */
  negotiatedCapabilities?: readonly string[];
  /** Versi sesi yang sudah berjalan, bila ada. */
  currentVersion?: RatchetWireVersion | null;
  /** Uji/kill-switch; default `spqrSendingEnabled()`. */
  integrationEnabled?: boolean;
}

export interface RatchetVersionDecision {
  version: RatchetWireVersion;
  reason: RatchetVersionReason;
  /**
   * Versi yang state-nya WAJIB dipertahankan setelah keputusan ini (rollback
   * v2→v1). `null`/`undefined` = tidak ada yang perlu dipertahankan.
   */
  preservedVersion?: RatchetWireVersion | null;
}

/**
 * Kapabilitas yang diiklankan klien pada hello. Ini satu-satunya tempat nama
 * `spqr-ratchet` keluar ke jaringan — mematikannya cukup dengan kill switch
 * (`VITE_SPQR_FORCE_V1=1` atau kill switch runtime DEV).
 */
export function advertisedCapabilities(enabled: boolean = spqrSendingEnabled()): string[] {
  return enabled ? [SPQR_CAPABILITY] : [];
}

/**
 * Tentukan versi ratchet untuk sebuah sesi.
 *
 * Sesi yang **sudah berdiri** mempertahankan versinya (aturan 1): masukan
 * kapabilitas diabaikan, karena mencocokkan ulang di tengah sesi adalah cara
 * termudah kehilangan riwayat pesan. Untuk sesi baru, v2 hanya dipakai bila
 * kedua sisi mampu (aturan 2).
 */
export interface OutboundRatchetInput {
  /** Versi yang sedang dipakai untuk pengiriman di sesi ini. */
  currentOutbound?: RatchetWireVersion | null;
  /**
   * Versi yang **dinyatakan peer** lewat payload ter-seal (`ackV`, lihat
   * `spqrWire.extractVersionDeclaration`). `null` = peer belum menyatakan
   * mampu v2 → jalur v1.
   */
  peerDeclaredVersion?: RatchetWireVersion | null;
  /** Kapabilitas transport hasil negosiasi (client ∩ relay). */
  negotiatedCapabilities?: readonly string[];
  /** Uji/kill-switch; default `spqrSendingEnabled()`. */
  integrationEnabled?: boolean;
  /** Uji/E2E: perlakukan kapabilitas relay sebagai tersedia. */
  capabilityOverride?: boolean;
}

/**
 * Versi yang dipakai untuk **mengirim** pada sesi ini.
 *
 * Berbeda dari `resolveRatchetVersion` (keputusan saat sesi didirikan, murni
 * dari kapabilitas), fungsi ini dijalankan pada tiap pengiriman dan menuntut
 * **bukti dari peer**: deklarasi `ackV` di dalam payload ter-seal. Aturannya:
 *
 *  1. Kill switch mati → v1 (state braid dipertahankan bila sebelumnya v2).
 *  2. Peer tidak (atau tidak lagi) menyatakan mampu v2 → v1. Bila sebelumnya
 *     kami sudah v2, ini **rollback** eksplisit: `preservedVersion: 'v2'`
 *     memberi tahu pemanggil supaya state braid TIDAK dihapus (`docs/33` §33.8).
 *  3. Sudah v2 → tetap v2 **sticky**: hilangnya kapabilitas transport di tengah
 *     sesi (mis. reconnect jatuh ke WSS) tidak boleh menurunkan versi — kapal
 *     yang sama yang melewatkan frame juga yang mengabarkan kapabilitas.
 *  4. Belum v2 + relay mengiklankan kapabilitas + peer menyatakan mampu → v2.
 */
export function resolveOutboundRatchetVersion(input: OutboundRatchetInput = {}): RatchetVersionDecision {
  // Default membaca saklar **per pengiriman** (`spqrSendingEnabled`), bukan
  // konstanta build-time: itulah yang membuat kill switch runtime langsung
  // berlaku sebagai rollback pada pesan berikutnya.
  const enabled = input.integrationEnabled ?? spqrSendingEnabled();

  if (!enabled) return downgrade(input.currentOutbound, 'local-disabled');

  if (input.peerDeclaredVersion !== 'v2') {
    return input.currentOutbound === 'v2'
      ? downgrade(input.currentOutbound, 'rollback')
      : { version: 'v1', reason: 'peer-legacy' };
  }

  if (input.currentOutbound === 'v2') return { version: 'v2', reason: 'established' };

  const relayCapable =
    input.capabilityOverride === true ||
    (input.negotiatedCapabilities ?? []).includes(SPQR_CAPABILITY);
  if (!relayCapable) return { version: 'v1', reason: 'peer-legacy' };

  return { version: 'v2', reason: 'both-capable' };
}

/** v1 dengan catatan state yang harus dipertahankan bila sebelumnya v2. */
function downgrade(
  currentOutbound: RatchetWireVersion | null | undefined,
  reason: RatchetVersionReason
): RatchetVersionDecision {
  if (currentOutbound === 'v2') {
    return { version: 'v1', reason, preservedVersion: planRatchetRollback('v2').preservedVersion };
  }
  return { version: 'v1', reason };
}

export function resolveRatchetVersion(input: RatchetNegotiationInput = {}): RatchetVersionDecision {
  const enabled = input.integrationEnabled ?? spqrSendingEnabled();

  if (input.currentVersion) {
    return { version: input.currentVersion, reason: 'established' };
  }

  if (!enabled) return { version: 'v1', reason: 'local-disabled' };

  const peerCapable = (input.negotiatedCapabilities ?? []).includes(SPQR_CAPABILITY);
  if (!peerCapable) return { version: 'v1', reason: 'peer-legacy' };

  return { version: 'v2', reason: 'both-capable' };
}

export interface RatchetRollbackPlan {
  /** Versi yang dipakai setelah rollback (selalu v1 — jalur yang beku & teruji). */
  version: 'v1';
  /** Versi yang state-nya harus DIPERTAHANKAN agar pesan lama tetap terbaca. */
  preservedVersion: RatchetWireVersion | null;
}

/**
 * Rencana rollback eksplisit v2 → v1.
 *
 * Pemanggil WAJIB mempertahankan state `preservedVersion` (jendela baca pesan
 * lama). Fungsi ini tidak menghapus apa pun: membersihkan state braid hanya boleh
 * dilakukan wipe/panic, bukan rollback.
 */
export function planRatchetRollback(currentVersion: RatchetWireVersion = 'v2'): RatchetRollbackPlan {
  return {
    version: 'v1',
    preservedVersion: currentVersion === 'v2' ? 'v2' : null,
  };
}
