// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { create } from 'zustand';
import { Conversation } from './conversation';
import { useAuthStore } from './auth';
import { computeSafetyNumberParts, PeerSecurityInfo } from '@utils/safetyNumber';
import { getParticipantUserId } from '@nyx/shared';
import { db } from '@lib/db';
import { decryptValueAtRest, encryptValueAtRest } from '@lib/keychainDb';
import {
  acceptPendingPeerIdentity,
  listPendingPeerIdentityChanges,
  type IdentityChangeSource,
} from '@lib/peerIdentityTrust';

/**
 * [docs/29 §7.2] State verifikasi percakapan.
 *
 * Dulu `verified_conversation_*` disimpan di **localStorage**: tidak
 * ditandatangani, tidak terikat masterSeed, dan bisa ditulis skrip/console mana
 * pun (atau hilang tanpa jejak saat wipe). Sekarang fingerprint safety number
 * hidup di `db.kvStore` sebagai blob **ENC1:** (masterSeed-bound) — sama seperti
 * admin token grup & pin identitas peer. Nilai localStorage lama dimigrasikan
 * sekali (fail-open: bila gagal, user cukup memverifikasi ulang).
 *
 * Store ini juga memuat `identityAlerts` — daftar perubahan kunci identitas peer
 * yang belum diterima user. UI memakainya untuk memblokir kirim (hard gate
 * §7.2); menerima = memverifikasi safety number baru (`setVerified`).
 *
 * [docs/34 §34.6 poin 1] Sejak verifikasi log KT masuk jalur bundle, alert juga
 * membawa `source`: `kt` berarti kunci bertentangan dengan **log publik**
 * (indikasi MITM terarah), `tofu` berarti rotasi kunci biasa.
 */

const KV_KEY = 'nyx_conversation_verification_v1';
const LEGACY_PREFIX = 'verified_conversation_';

export interface IdentityAlert {
  peerId: string;
  previousKey: string;
  pendingKey: string;
  changedAt: number;
  /**
   * [docs/34 §34.6 poin 1] `kt` = kunci yang disajikan bertentangan dengan
   * **log Key Transparency** (bukti sah), bukan sekadar rotasi kunci biasa.
   * UI memakai ini untuk menampilkan peringatan yang lebih kuat.
   */
  source: IdentityChangeSource;
}

type VerificationState = {
  verifiedStatus: Record<string, boolean>;
  /** conversationId → perubahan kunci yang belum diterima (hard gate kirim). */
  identityAlerts: Record<string, IdentityAlert>;
  loadInitialStatus: (conversations: Conversation[]) => Promise<void>;
  setVerified: (conversationId: string, peerPublicKey: string, peerUserId?: string) => void;
  unsetVerified: (conversationId: string) => void;
};

// Helper to compute fingerprint for safety number
export const computeFingerprint = async (peer: PeerSecurityInfo) => {
  try {
      const { generateSafetyNumber } = await import('@lib/crypto-worker-proxy');
      const { getEncryptionKeyPair, getPqEncryptionKeyPair, getSigningPrivateKey } = useAuthStore.getState();

      const keyPair = await getEncryptionKeyPair();
      if (!keyPair || !keyPair.publicKey) return peer.publicKey;

      const pqKeyPair = await getPqEncryptionKeyPair().catch(() => null);
      const mySigningKey = await getSigningPrivateKey();

      const { myPublicKeyCombined, theirPublicKeyCombined } = await computeSafetyNumberParts(
        keyPair.publicKey,
        pqKeyPair?.publicKey || null,
        mySigningKey,
        peer
      );

      return await generateSafetyNumber(myPublicKeyCombined, theirPublicKeyCombined);
  } catch (e) {
      console.error('Failed to compute safety fingerprint', e);
      return null;
  }
};

/** Baca fingerprint terverifikasi dari kvStore (ENC1), dengan migrasi localStorage sekali. */
async function loadStoredVerifications(): Promise<Record<string, string>> {
  try {
    const row = await db.kvStore.get(KV_KEY);
    const stored = typeof row?.value === 'string' ? row.value : null;
    if (stored) {
      const plain = await decryptValueAtRest(stored);
      if (plain) {
        const parsed = JSON.parse(plain) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, string>;
        }
      }
    }
  } catch (e) {
    console.warn('[Verification] Gagal membaca state terenkripsi:', e);
  }

  // Migrasi sekali dari localStorage (bentuk lama, tanpa tanda tangan).
  try {
    const migrated: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LEGACY_PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (value) migrated[key.slice(LEGACY_PREFIX.length)] = value;
    }
    if (Object.keys(migrated).length > 0) {
      await persistStoredVerifications(migrated);
      for (const convId of Object.keys(migrated)) {
        localStorage.removeItem(`${LEGACY_PREFIX}${convId}`);
      }
      console.info(`[Verification] ${Object.keys(migrated).length} status verifikasi dipindahkan ke keychain terenkripsi (docs/29 §7.2).`);
    }
    return migrated;
  } catch {
    return {};
  }
}

async function persistStoredVerifications(map: Record<string, string>): Promise<void> {
  try {
    await db.kvStore.put({ key: KV_KEY, value: await encryptValueAtRest(JSON.stringify(map)) });
  } catch (e) {
    console.error('[Verification] Gagal menyimpan state verifikasi:', e);
  }
}

/** Alert perubahan kunci untuk percakapan yang ada di daftar (1:1 saja). */
async function collectIdentityAlerts(conversations: Conversation[]): Promise<Record<string, IdentityAlert>> {
  const alerts: Record<string, IdentityAlert> = {};
  try {
    const pending = await listPendingPeerIdentityChanges();
    if (pending.length === 0) return alerts;
    const myId = useAuthStore.getState().user?.id;
    const byPeer = new Map(pending.map(p => [p.peerId, p]));
    for (const convo of conversations) {
      if (convo.isGroup) continue;
      const peer = convo.participants.find(p => getParticipantUserId(p) !== myId);
      if (!peer) continue;
      const found = byPeer.get(getParticipantUserId(peer));
      if (found) alerts[convo.id] = found;
    }
  } catch (e) {
    console.warn('[Verification] Gagal memuat alert identitas:', e);
  }
  return alerts;
}

export const useVerificationStore = create<VerificationState>((set) => ({
  verifiedStatus: {},
  identityAlerts: {},

  loadInitialStatus: async (conversations) => {
    const initialStatus: Record<string, boolean> = {};
    const stored = await loadStoredVerifications();
    let migrated = false;

    for (const convo of conversations) {
      // [P2 NORMALISASI] getParticipantUserId (dulu p.id && p.userId ganda —
      // bentuk pseudonym terlewat).
      const myId = useAuthStore.getState().user?.id;
      const participant = convo.participants.find(p => getParticipantUserId(p) !== myId);
      const peer = participant?.user;
      if (peer && peer.publicKey) {
        const storedKey = stored[convo.id];
        if (storedKey) {
          const fingerprint = await computeFingerprint(peer as import('@utils/safetyNumber').PeerSecurityInfo);
          if (storedKey === fingerprint) {
            initialStatus[convo.id] = true;
          } else if (fingerprint && storedKey === peer.publicKey) {
            // Upgrade bentuk lama (kunci mentah, bukan fingerprint) → tetap
            // terverifikasi, tapi disimpan dalam bentuk fingerprint.
            stored[convo.id] = fingerprint;
            migrated = true;
            initialStatus[convo.id] = true;
          }
        }
      }
    }

    if (migrated) await persistStoredVerifications(stored);

    const identityAlerts = await collectIdentityAlerts(conversations);
    set({ verifiedStatus: initialStatus, identityAlerts });
  },

  setVerified: (conversationId, fingerprint, peerUserId) => {
    if (!fingerprint) return;
    set(state => ({
      verifiedStatus: { ...state.verifiedStatus, [conversationId]: true },
      identityAlerts: Object.fromEntries(
        Object.entries(state.identityAlerts).filter(([id]) => id !== conversationId)
      ),
    }));
    void (async () => {
      const stored = await loadStoredVerifications();
      stored[conversationId] = fingerprint;
      await persistStoredVerifications(stored);
      // Verifikasi safety number = user menerima kunci baru → pin berubah.
      if (peerUserId) {
        const accepted = await acceptPendingPeerIdentity(peerUserId);
        if (accepted) {
          console.info('[Verification] Kunci identitas baru diterima setelah verifikasi safety number.');
        }
      }
    })();
  },

  unsetVerified: (conversationId) => {
    set(state => {
      const nextStatus = { ...state.verifiedStatus };
      delete nextStatus[conversationId];
      return { verifiedStatus: nextStatus };
    });
    void (async () => {
      const stored = await loadStoredVerifications();
      delete stored[conversationId];
      await persistStoredVerifications(stored);
    })();
  },
}));

/**
 * Apakah ada perubahan kunci yang belum diterima untuk percakapan ini?
 * Dipakai composer/gate kirim (hard gate docs/29 §7.2).
 */
export function hasIdentityAlert(conversationId: string): boolean {
  return !!useVerificationStore.getState().identityAlerts[conversationId];
}
