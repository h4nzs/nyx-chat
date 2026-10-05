// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [PROFILE KEY DISTRIBUTION 2026-10-05] Distribusi kunci profil grup lewat
 * roster metadata v3 + silent PROFILE_SYNC.
 *
 * Masalah: kunci profil anggota hanya terdistribusi lewat payload PESAN dari
 * anggota itu sendiri (message.ts menyuntik profileKey saat kirim). Anggota
 * pasif (belum pernah kirim pesan) tidak pernah menyebarkan kuncinya →
 * namanya tak bisa didekripsi anggota lain → "Anonymous" di picker/panel.
 *
 * Solusi dua kanal (server tetap opaque — server hanya melihat blob metadata
 * opaque + pesan silent; kunci profil adalah kunci simetris per-user yang
 * memang didesain untuk dibagikan ke peer):
 *   1. ROSTER: penulis metadata (creator/admin — pola Signal sender-keys)
 *      menyuntikkan profileKey MILIKNYA sendiri ke entri roster-nya saat
 *      encryptGroupMetadata. Semua pembaca metadata mendapat kunci itu.
 *   2. SILENT PROFILE_SYNC: anggota yang melihat entri roster-nya kosong
 *      (kunci tak sempat di-inject, mis. kunci lahir setelah metadata) atau
 *      menerima PROFILE_SYNC dari peer yang entri-nya masih kosong, mengirim
 *      SATU pesan silent sekali per (device, conversation) — tanpa bubble,
 *      tanpa push, mengikuti pola GHOST_SYNC.
 */
import { parseGroupMembers } from '@nyx/shared';
import { useConversationStore } from '@store/conversation';

const firedProfileSync = new Set<string>();

// Helper auth — dynamic import agar module ini ringan di-import di jalur mana
// pun (conversation store di-import statis untuk roster lookup).
async function require_auth_id(): Promise<string> {
  const { useAuthStore } = await import('@store/auth');
  const id = useAuthStore.getState().user?.id;
  if (!id) throw new Error('Not authenticated');
  return id;
}

export interface RosterKeySummary {
  mine: boolean;      // apakah entri SAYA di roster membawa profileKey
  total: number;      // total entri roster (valid)
  withKeys: number;   // entri yang membawa profileKey
}

/** Roster v3 dari metadata terdekripsi (undefined = bukan metadata v3). */
function getDecryptedRoster(conversationId: string): ReturnType<typeof parseGroupMembers> | undefined {
  const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  const meta = conv?.decryptedMetadata as { v?: number; members?: unknown } | undefined;
  if (!meta || (meta.v !== 3)) return undefined;
  return parseGroupMembers(meta.members);
}

/**
 * [PENULIS METADATA] Merge profileKey SAYA ke roster yang akan di-enkripsi.
 * Dipanggil dari encryptGroupMetadata (situs penulis tunggal) — creator saat
 * createGroup, admin saat rotasi → kunci profil tersebar ke seluruh anggota
 * lewat metadata, tanpa kanal tambahan.
 */
export async function mergeMyProfileKeyIntoRoster(
  members: Array<{ userId: string; role: string; joinedAtGeneration: number; profileKey?: string }> ,
  conversationId: string,
): Promise<void> {
  try {
    const myId = await require_auth_id();
    const { getProfileKey } = await import('@lib/keychainDb');
    const myKey = await getProfileKey(myId);
    if (!myKey) return; // kunci belum tersedia — PROFILE_SYNC menutup nanti
    const entry = members.find(m => m.userId === myId);
    if (entry) {
      entry.profileKey = myKey;
    } else {
      // Entri saya belum ada di roster (roster korup/entri dibuang parser) —
      // TIDAK menambah entri (roster bukan urusan module ini).
      return;
    }
  } catch {
    // Best-effort: metadata tetap ditulis walau kunci gagal dibaca.
  }
}

/**
 * [PEMBACA METADATA] Simpan kunci profil anggota dari roster terdekripsi.
 * Kunci peer yang dikenal (sudah ada di keychain) TIDAK pernah ditimpa
 * (first-wins — rotasi kunci profil bukan fitur; profil di-update peer
 * membawa ep baru + kunci sama). Return ringkasan untuk trigger PROFILE_SYNC.
 */
export async function applyGroupProfileKeys(
  conversationId: string,
  membersRaw: unknown,
): Promise<RosterKeySummary> {
  const summary: RosterKeySummary = { mine: false, total: 0, withKeys: 0 };
  const roster = getDecryptedRoster(conversationId);
  const members = parseGroupMembers(membersRaw);
  const rosterList = roster ?? members;
  if (!rosterList || rosterList.length === 0) return summary;
  const myId = await require_auth_id().catch(() => '');
  const { getProfileKey, saveProfileKey } = await import('@lib/keychainDb');
  let myEntryMissingKey = false;
  for (const m of rosterList) {
    summary.total++;
    if (m.userId === myId) {
      summary.mine = Boolean(m.profileKey);
      if (!m.profileKey) myEntryMissingKey = true;
      continue; // kunci sendiri tak perlu disimpan
    }
    if (!m.profileKey) continue;
    summary.withKeys++;
    const existing = await getProfileKey(m.userId);
    if (!existing) {
      await saveProfileKey(m.userId, m.profileKey!).catch(() => {});
    }
  }
  // [FALLBACK TRIGGER] Entri saya di roster tak membawa kunci (metadata
  // ditulis sebelum kunci saya tersedia / dibuat client lawas) → kirim SATU
  // silent PROFILE_SYNC sekali per (device, conversation).
  if (myEntryMissingKey) void maybeFireProfileSync(conversationId);
  return summary;
}

/**
 * Cek non-mutating untuk trigger (fireProfileSync): true bila dedupe belum
 * terpakai DAN (tidak ada roster v3 ATAU entri saya belum membawa kunci).
 */
export async function shouldFireProfileSync(conversationId: string): Promise<boolean> {
  if (firedProfileSync.has(conversationId)) return false;
  const roster = getDecryptedRoster(conversationId);
  if (!roster) return true; // metadata belum terdekripsi / bukan v3 — fail-open
  const myId = await require_auth_id().catch(() => '');
  if (!myId) return false;
  const mine = roster.find(m => m.userId === myId);
  return mine ? !mine.profileKey : true; // entri saya hilang → kunci saya belum tersebar
}

/**
 * Fallback sekali per (device, conversation): kirim profileKey saya sebagai
 * pesan silent PROFILE_SYNC (pola GHOST_SYNC — tanpa bubble/push).
 */
export async function maybeFireProfileSync(conversationId: string): Promise<boolean> {
  if (firedProfileSync.has(conversationId)) return false;
  try {
    const myId = await require_auth_id();
    const { getProfileKey } = await import('@lib/keychainDb');
    const key = await getProfileKey(myId);
    if (!key) return false; // kunci belum ada — pemanggil lain nanti mencoba lagi
    firedProfileSync.add(conversationId);
    const { useMessageStore } = await import('@store/message');
    await useMessageStore.getState().sendMessage(conversationId, {
      content: JSON.stringify({ type: 'PROFILE_SYNC', profileKey: key }),
      isSilent: true,
    });
    return true;
  } catch {
    // Jangan tandai fired bila gagal kirim — percobaan berikutnya mencoba lagi.
    return false;
  }
}

/** Reset dedupe (test + logout/wipe). */
export function resetProfileSyncState(): void {
  firedProfileSync.clear();
}
