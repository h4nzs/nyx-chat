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
// 2. Omit-ct dengan ack — header DR membawa `ct` KEM (1120 byte) yang hanya
//    dibutuhkan receiver yang BELUM step ke chain pengirim. Receiver meng-ack
//    KEMr-nya di dalam payload terenkripsi (`ackKem`); bila ack = chain
//    pengirim saat ini, `ct` dihilangkan dari header (~1.5KB/pesan hemat).
//    Receiver yang belum step tetap menerima ct → tetap bisa step.

/** Bidang state DR yang relevan untuk keputusan protokol (sisi klien). */
export interface DrProtocolStateView {
  peerSessionConfirmed?: boolean;
  pendingHandshake?: {
    initiatorSigningKey: string;
    initiatorCiphertexts: string;
    otpkId?: number;
  } | null;
  peerAckedKem?: string | null;
}

/** Payload x3dh yang menempel di wrapper pesan (plaintext envelope). */
export interface DrHandshakePayload {
  initiatorSigningKey: string;
  initiatorCiphertexts: string;
  otpkId?: number;
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
 * Apakah `ct` boleh dihilangkan dari header pesan keluar?
 * Syarat: peer sudah meng-ack bahwa KEMr-nya = chain kita saat ini — dia tidak
 * lagi butuh ct untuk step (dia sudah berada di chain ini).
 */
export function shouldOmitRatchetCt(
  peerAckedKem: string | null | undefined,
  currentKemPkB64: string | null | undefined
): boolean {
  if (!peerAckedKem || !currentKemPkB64) return false;
  return peerAckedKem === currentKemPkB64;
}

/**
 * Proses `ackKem` dari payload terenkripsi pesan masuk. Return nilai
 * `peerAckedKem` baru untuk state, atau null bila payload bukan JSON/ tanpa
 * ack. Ack HANYA diterima dari payload yang berhasil didekripsi (otentikasi
 * AEAD) — tidak pernah dari envelope mentah.
 */
export function extractPeerAck(decryptedPlaintext: string): string | null {
  try {
    const parsed = JSON.parse(decryptedPlaintext) as { ackKem?: unknown };
    if (parsed && typeof parsed.ackKem === 'string' && parsed.ackKem.length > 0) {
      return parsed.ackKem;
    }
  } catch {
    // plaintext bukan JSON sealed-payload (mis. konten legacy) — tanpa ack.
  }
  return null;
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
    peerAckedKem:
      patch.peerAckedKem !== undefined
        ? patch.peerAckedKem
        : (previous.peerAckedKem ?? null),
  };
}
