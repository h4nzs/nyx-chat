// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3] Bukti Privacy Pass pada sync anonim.
 *
 * Sync tidak punya akun untuk di-rate-limit, jadi abuse ditahan dengan aturan
 * per token. Privacy Pass menambahkan alasan yang **tidak bisa dikaitkan** ke
 * issuance: satu token = satu sync. Fungsi ini memisahkan keputusan itu dari
 * route supaya bisa diuji tanpa Express/Redis.
 *
 * Aturan yang dijaga:
 *  - bukti terikat ke `conversationId` (pesan yang ditandatangani issuer memuat
 *    id itu), jadi bukti grup A **tidak** mengizinkan sync grup B;
 *  - satu bukti = satu sync: berhenti pada `ok` pertama, tidak menghabiskan
 *    token lain yang dikirim;
 *  - `required: false` (default deployment) hanya mencatat; `required: true`
 *    (env `PP_SYNC_REQUIRED=1`) menolak sync tanpa bukti sah — fail-closed.
 */

export type SyncProofOutcome = 'ok' | 'spent' | 'invalid'

export interface SyncProofDecision {
  /** Sync boleh dilanjutkan? */
  ok: boolean
  /** Jumlah bukti yang benar-benar diterima (0 atau 1). */
  accepted: number
}

/** Batas percakapan yang dicoba per bukti — mencegah verifikasi RSA berlipat. */
const MAX_PROOF_CONVERSATIONS = 10

export async function evaluateSyncProofs (input: {
  proofs: readonly string[]
  conversationIds: readonly string[]
  required: boolean
  redeem: (conversationId: string, token: string) => Promise<SyncProofOutcome>
}): Promise<SyncProofDecision> {
  const conversationIds = [...new Set(input.conversationIds)].slice(0, MAX_PROOF_CONVERSATIONS)

  for (const proof of input.proofs) {
    for (const conversationId of conversationIds) {
      if (await input.redeem(conversationId, proof) === 'ok') {
        return { ok: true, accepted: 1 }
      }
    }
  }

  return { ok: !input.required, accepted: 0 }
}
