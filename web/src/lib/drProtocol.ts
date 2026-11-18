// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
// web/src/lib/drProtocol.ts
//
// [DR PROTOCOL 2026-10-05] Helper PURE untuk dua keputusan protokol 1:1:
//
// 1. x3dh-until-confirmed — pengirim menyertakan payload x3dh di SETIAP pesan
//    sampai ada bukti peer memegang sesi (balasan pertama berhasil didekripsi).
//    Menutup kasus `waiting_for_ratchet_state` tanpa self-heal: bila pesan
//    pertama (satu-satunya pembawa x3dh) hilang/expired, pesan berikutnya tetap
//    membawa handshake sehingga peer bisa derive kapan pun dia online.
//    Re-derive peer deterministik (sk = f(handshake yang sama) dan langkah
//    ratchet KEM murni fungsi dari (sk, ct, kemPk)) → aman.
//
// [docs/43 §43.3.2] Wire ratchet hanya braid v2, jadi tidak ada lagi keputusan
// versi maupun omit-ct v1 yang perlu disimpan di state klien.

/** Bidang state DR yang relevan untuk keputusan protokol (sisi klien). */
export interface DrProtocolStateView {
  peerSessionConfirmed?: boolean;
  pendingHandshake?: {
    /** @deprecated v1 reader dihapus (PQ-only); masih dibaca untuk state lama. */
    initiatorSigningKey?: string;
    initiatorCiphertexts: string;
    otpkId?: number;
    /** 2 = handshake X-Wing murni + tanda tangan ML-DSA (docs/35 Fase 1.4). */
    handshakeVersion?: number;
    /** `signingKeyV2` inisiator (ML-DSA) — verifikasi tanda tangan handshake v2. */
    initiatorSigningKeyV2?: string;
  } | null;
  /** Akar braid v2 (rahasia X3DH, base64url) — lihat `DoubleRatchetState`. */
  spqrAuthKey?: string;
  /** Peran braid v2 (`A2B` = inisiator, `B2A` = penerima). */
  spqrDirection?: 'A2B' | 'B2A';
}

/** Payload x3dh yang menempel di wrapper pesan (plaintext envelope). */
export interface DrHandshakePayload {
  /** @deprecated v1 reader dihapus (PQ-only); field lama tetap diabaikan. */
  initiatorSigningKey?: string;
  initiatorCiphertexts: string;
  otpkId?: number;
  handshakeVersion?: number;
  initiatorSigningKeyV2?: string;
}

/**
 * Apakah wrapper pesan keluar (1:1, inisiator) harus membawa `x3dh`?
 *
 * `justEstablished` = kita BARU saja melakukan X3DH di call ini (belum pernah
 * kirim) → wajib bawa. Sisanya: bawa selama `peerSessionConfirmed` belum true
 * DAN salinan handshake masih ada di state. Penerima (sisi bob, state dari
 * `dr_init_bob`) tidak pernah membawa handshake — caller memutuskan via
 * `getHandshakePayload` yang return null untuk state tanpa salinan.
 */
export function shouldIncludeHandshake(
  state: DrProtocolStateView,
  justEstablished: boolean
): boolean {
  if (justEstablished) return true;
  if (state.peerSessionConfirmed) return false;
  return !!state.pendingHandshake;
}

/**
 * Ambil payload handshake yang harus dikirim, atau null. Hanya inisiator yang
 * punya `pendingHandshake` — penerima return null (wrapper tanpa x3dh).
 */
export function getHandshakePayload(
  state: DrProtocolStateView
): DrHandshakePayload | null {
  if (state.peerSessionConfirmed) return null;
  return state.pendingHandshake ?? null;
}

/**
 * [ECHO FIX 2026-10-05] Pangkas padding traffic-cover dari plaintext hasil
 * `secretbox_open_easy` mentah. Ciphertext DR/group berisi plaintext PADDED
 * (mirror `padBuffer`/`unpadBuffer` di crypto.worker.ts — payload + marker
 * `0x80` + zero-fill); op worker (dr_ratchet_decrypt, group_ratchet_decrypt)
 * memangkas internal, tapi jalur MK-cache / self-decrypt yang memakai op
 * `secretbox_open_easy` MENTAH mendapat buffer ber-padded — `to_string`
 * (TextDecoder fatal) melempar "The encoded data is not valid" pada byte
 * `0x80` → semua echo pesan sendiri gagal self-decrypt (log 15:34).
 * Sama persis dengan `unpadBuffer` worker; passthrough bila marker tidak ada.
 */
export function trimPaddedPlaintext(buf: Uint8Array): Uint8Array {
  let i = buf.length - 1;
  while (i >= 0 && buf[i] === 0) i--;
  if (i < 0 || buf[i] !== 0x80) return buf;
  return buf.slice(0, i);
}

/**
 * Gabungkan bidang protokol klien ke state hasil worker sebelum dipersist.
 * Worker meng-serialize ulang state dengan field eksplisit, sehingga bidang
 * klien-side HARUS ditempel ulang di sini (jika tidak akan ter-strip).
 */
export function attachClientProtocolFields<S extends object>(
  workerState: S,
  previous: DrProtocolStateView,
  patch: DrProtocolStateView
): S & DrProtocolStateView {
  return {
    ...workerState,
    peerSessionConfirmed:
      patch.peerSessionConfirmed ?? previous.peerSessionConfirmed ?? false,
    pendingHandshake:
      patch.pendingHandshake !== undefined
        ? patch.pendingHandshake
        : (previous.pendingHandshake ?? null),
    spqrAuthKey:
      patch.spqrAuthKey !== undefined ? patch.spqrAuthKey : previous.spqrAuthKey,
    spqrDirection:
      patch.spqrDirection !== undefined ? patch.spqrDirection : previous.spqrDirection,
  };
}
