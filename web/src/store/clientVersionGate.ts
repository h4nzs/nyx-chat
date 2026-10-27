// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [R2 2026-10-15 · 2026-10-27] Status gerbang versi klien untuk UI.
 *
 * Server menjawab `426` dalam dua bentuk:
 *   - `CLIENT_TOO_OLD` — versi build terbaca dan di bawah `MIN_CLIENT_VERSION`.
 *     Semua request ditolak, jadi aplikasi tidak bisa dipakai sama sekali;
 *   - `CLIENT_VERSION_REQUIRED` — mode ketat `CLIENT_VERSION_REQUIRE_MUTATIONS=1`
 *     dan request **mutasi** tidak menyertakan versi yang bisa dibaca. Baca
 *     masih jalan; yang gagal adalah tindakan yang mengubah state.
 *
 * Sebelumnya keduanya (yang pertama saja, sebenarnya) hanya menjadi toast
 * `duration: Infinity`. Toast bisa terlewat, tertutup toast lain, dan tidak
 * menjelaskan apa yang harus dilakukan — padahal ini justru kasus di mana
 * pengguna terus kehilangan pesan grup sampai ia memperbarui. Karena itu
 * state-nya dipisah dari `api.ts` supaya bisa dirender sebagai layar penuh
 * (`pages/ClientVersionRequiredPage.tsx`) dan diuji tanpa DOM.
 */

import { create } from 'zustand';

export type ClientVersionRejectionKind = 'too-old' | 'version-required';

export interface ClientVersionRejection {
  kind: ClientVersionRejectionKind;
  /** Versi minimum yang disebut server (bisa tidak ada pada respons lama). */
  minimumVersion?: string | undefined;
  /** Versi klien yang dibaca server (tidak ada pada `version-required`). */
  clientVersion?: string | undefined;
}

export interface ClientVersionMeta {
  minimumVersion?: string | undefined;
  clientVersion?: string | undefined;
}

interface ClientVersionGateState {
  rejection: ClientVersionRejection | null;
  /**
   * Hanya berlaku untuk `version-required`: baca masih berfungsi, jadi
   * pengguna boleh menutup layar dan melanjutkan tanpa mengirim.
   * `too-old` tidak pernah bisa ditutup — semua request gagal.
   */
  dismissed: boolean;
  report: (kind: ClientVersionRejectionKind, meta?: ClientVersionMeta) => void;
  dismiss: () => void;
  reset: () => void;
}

/** `too-old` menang atas `version-required` (lebih ketat, tidak bisa ditutup). */
const SEVERITY: Record<ClientVersionRejectionKind, number> = {
  'too-old': 2,
  'version-required': 1,
};

export const useClientVersionGateStore = create<ClientVersionGateState>((set) => ({
  rejection: null,
  dismissed: false,

  report: (kind, meta = {}) =>
    set((state) => {
      const current = state.rejection;
      // Jangan turunkan tingkat: layar "semua request gagal" tidak boleh
      // berubah menjadi "hanya mutasi yang gagal" karena satu request lain.
      if (current && SEVERITY[current.kind] > SEVERITY[kind]) return state;

      const sameKind = current?.kind === kind;
      return {
        rejection: {
          kind,
          // Respons berikutnya boleh membawa minimum yang lebih baru (operator
          // menaikkan `MIN_CLIENT_VERSION`); nilai lama dipakai bila tidak ada.
          minimumVersion: meta.minimumVersion ?? current?.minimumVersion,
          clientVersion: meta.clientVersion ?? current?.clientVersion,
        },
        // Pengulangan jenis yang sama tidak membuka kembali layar yang sudah
        // ditutup pada mode yang boleh ditutup (mis. setiap percobaan kirim).
        dismissed: sameKind ? state.dismissed : false,
      };
    }),

  dismiss: () =>
    set((state) =>
      state.rejection?.kind === 'version-required' ? { dismissed: true } : state
    ),

  reset: () => set({ rejection: null, dismissed: false }),
}));

/**
 * Terjemahkan body error 426 menjadi state UI. Mengembalikan `false` bila kode
 * error bukan salah satu dari dua kontrak di atas — respons 426 dari pihak lain
 * tidak boleh memunculkan layar versi.
 */
export function reportClientVersionRejection(details: unknown): boolean {
  if (typeof details !== 'object' || details === null) return false;

  const body = details as {
    error?: unknown;
    minimumVersion?: unknown;
    clientVersion?: unknown;
  };
  const kind: ClientVersionRejectionKind | null =
    body.error === 'CLIENT_TOO_OLD'
      ? 'too-old'
      : body.error === 'CLIENT_VERSION_REQUIRED'
        ? 'version-required'
        : null;
  if (!kind) return false;

  useClientVersionGateStore.getState().report(kind, {
    minimumVersion: typeof body.minimumVersion === 'string' ? body.minimumVersion : undefined,
    clientVersion: typeof body.clientVersion === 'string' ? body.clientVersion : undefined,
  });
  return true;
}
