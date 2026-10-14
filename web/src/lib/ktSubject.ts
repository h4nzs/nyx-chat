// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/34 §34.6 poin 1] Menurunkan **username peer** — satu-satunya bahan yang
 * bisa dipakai untuk mencari subjek di log Key Transparency.
 *
 * Kenapa perlu modul terpisah: search key log adalah `0x75 || Argon2id(username)`,
 * dan NYX **tidak menyimpan username plaintext di mana pun di server** (yang ada
 * hanya `usernameHash` ter-pepper, `docs/14`). Klien pun hanya tahu username
 * dirinya sendiri (dari login). Username peer satu-satunya sumbernya adalah
 * **profil E2EE** yang dibagikan peer — jadi verifikasi KT mustahil tanpa
 * mendekripsi profil peer lebih dulu. Sebelum modul ini, `ktBundleProof` hanya
 * menerima `username` dari pemanggil dan pemanggil tidak punya cara
 * mendapatkannya → verifikasi KT selalu berakhir `unknown-subject`.
 *
 * Urutan sumber (murah → mahal):
 *   1. cache profil RAM (`profileStore.profiles`, alias plain-id)
 *   2. `participant.username` (store percakapan; terisi bila server/kontak bundle
 *      pernah mengirimnya)
 *   3. dekripsi `participant.encryptedProfile` (profil yang baru datang)
 *   4. dekripsi `contact.encryptedProfile` (profil tersimpan dari contact bundle)
 *
 * Semuanya **read-only dan fail-open**: kegagalan apa pun → `undefined`, dan
 * pemanggil memperlakukannya sebagai `unknown-subject` (TOFU), bukan error.
 * Hasil dekripsi di-cache di RAM (bukan IndexedDB) karena ini turunan dari
 * `profileCache` yang sudah tersimpan; cache hanya mempercepat, tidak menambah
 * data baru di disk.
 */

/** Batas cache RAM — daftar kontak NYX realistis jauh di bawah ini. */
const SUBJECT_CACHE_MAX = 500;

/**
 * Jeda sebelum menurunkan username peer yang sebelumnya GAGAL dicoba (ms).
 * Penurunan username dipanggil di jalur pemrosesan pesan, jadi kegagalan harus
 * dibatasi: percobaan ulang per pesan berarti satu baca Dexie (+ mungkin satu
 * percobaan dekripsi) untuk setiap pesan dari peer yang profilnya belum kita
 * punya. Satu menit cukup cepat untuk menangkap profil yang baru tiba, cukup
 * jarang untuk tidak membebani jalur pesan.
 */
export const KT_SUBJECT_MISS_RETRY_MS = 60 * 1000;

/** Username yang berhasil diturunkan (positif). */
const subjectCache = new Map<string, string>();
/** userId → waktu (ms) sampai kapan percobaan ulang ditahan (negatif). */
const missingUntil = new Map<string, number>();

export interface KtSubjectProfile {
  username?: string | undefined;
}

export interface KtSubjectDeps {
  /** Cache profil terdekripsi (RAM) keyed userId. */
  cachedProfiles?: () => Record<string, KtSubjectProfile | undefined>;
  /** Sumber `participant` (username + encryptedProfile) untuk userId ini. */
  participant?: (userId: string) => { username?: string; encryptedProfile?: string | null } | undefined;
  /** Ciphertext profil peer dari store kontak. */
  contactProfile?: (userId: string) => Promise<string | null | undefined>;
  /** Dekripsi profil E2EE (biasanya `profileStore.decryptAndCache`). */
  decryptProfile?: (userId: string, encryptedProfile: string) => Promise<KtSubjectProfile | null>;
}

/** Buang cache (test, unlock baru, wipe). */
export function clearKtSubjectCache(): void {
  subjectCache.clear();
  missingUntil.clear();
}

/**
 * Username plaintext peer, atau `undefined` bila belum bisa diketahui.
 *
 * Kegagalan ditahan `KT_SUBJECT_MISS_RETRY_MS` (bukan selamanya) supaya profil
 * yang baru masuk tetap bisa ditemukan, sementara jalur pesan tidak mencoba
 * menurunkan username untuk setiap pesan.
 */
export async function resolvePeerUsername(
  userId: string,
  deps: KtSubjectDeps = {},
  now: number = Date.now()
): Promise<string | undefined> {
  if (!userId) return undefined;
  const cached = subjectCache.get(userId);
  if (cached) return cached;

  const retryAt = missingUntil.get(userId);
  if (retryAt !== undefined && now < retryAt) return undefined;

  const found = await findUsername(userId, deps);
  if (!found) {
    missingUntil.set(userId, now + KT_SUBJECT_MISS_RETRY_MS);
    return undefined;
  }
  remember(userId, found);
  return found;
}

function remember(userId: string, username: string): void {
  if (subjectCache.size >= SUBJECT_CACHE_MAX) {
    const oldest = subjectCache.keys().next().value;
    if (oldest !== undefined) subjectCache.delete(oldest);
  }
  missingUntil.delete(userId);
  subjectCache.set(userId, username);
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function findUsername(userId: string, deps: KtSubjectDeps): Promise<string | undefined> {
  const warnings: string[] = [];

  try {
    const cachedProfiles = deps.cachedProfiles ? deps.cachedProfiles() : await defaultCachedProfiles();
    const direct = normalize(cachedProfiles[userId]?.username);
    if (direct) return direct;
    // Alias plain-id dijamin store profil; kalau tidak ada, coba key komposit
    // `<userId>_<32 char hash>` (profil yang hanya pernah didekripsi lewat
    // jalur pesan).
    const composite = Object.entries(cachedProfiles).find(
      ([key]) => key.startsWith(`${userId}_`) && key.length > userId.length + 1
    );
    const fromComposite = normalize(composite?.[1]?.username);
    if (fromComposite) return fromComposite;
  } catch (error) {
    warnings.push(`profil-cache: ${(error as Error).message}`);
  }

  let participant: { username?: string; encryptedProfile?: string | null } | undefined;
  try {
    participant = await (deps.participant ?? defaultParticipant)(userId);
  } catch (error) {
    warnings.push(`participant: ${(error as Error).message}`);
  }

  const fromParticipant = normalize(participant?.username);
  if (fromParticipant) return fromParticipant;

  const decrypt = deps.decryptProfile ?? defaultDecryptProfile;

  // Profil dari percakapan lebih baru daripada yang tersimpan di kontak bundle.
  for (const ciphertext of [participant?.encryptedProfile, await contactCiphertext(userId, deps)]) {
    if (!ciphertext) continue;
    try {
      const decrypted = await decrypt(userId, ciphertext);
      const username = normalize(decrypted?.username);
      if (username) return username;
    } catch (error) {
      warnings.push(`dekripsi: ${(error as Error).message}`);
    }
  }

  if (warnings.length > 0) {
    console.warn('[KT] Username peer belum bisa diturunkan:', { userId, warnings });
  }
  return undefined;
}

async function contactCiphertext(userId: string, deps: KtSubjectDeps): Promise<string | null | undefined> {
  try {
    const contactProfile = deps.contactProfile ?? defaultContactProfile;
    return await contactProfile(userId);
  } catch (error) {
    console.warn('[KT] Gagal membaca kontak untuk subjek log:', (error as Error).message);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Sumber default (impor dinamis: modul ini ikut jalur bundle kunci)
// ---------------------------------------------------------------------------

/**
 * Snapshot profil RAM dari store profil. Impor **dinamis** disengaja: modul ini
 * ikut grafik impor `peerIdentityTrust` yang dipanggil dari `utils/crypto.ts`,
 * dan store profil menarik worker crypto — impor statis akan membuat siklus
 * muat modul yang sulit dilacak.
 */
async function defaultCachedProfiles(): Promise<Record<string, KtSubjectProfile | undefined>> {
  const { useProfileStore } = await import('@store/profile');
  return useProfileStore.getState().profiles as Record<string, KtSubjectProfile | undefined>;
}

async function defaultParticipant(
  userId: string
): Promise<{ username?: string; encryptedProfile?: string | null } | undefined> {
  const [{ useConversationStore }, { getParticipantUserId }] = await Promise.all([
    import('@store/conversation'),
    import('@nyx/shared'),
  ]);
  const conversations = useConversationStore.getState().conversations;
  // Percakapan 1:1 lebih dulu: username peer 1:1 paling mungkin dibutuhkan.
  const sorted = [...conversations].sort((a, b) => Number(b.isGroup ?? false) - Number(a.isGroup ?? false));
  for (const conversation of sorted) {
    const participant = conversation.participants?.find((p) => getParticipantUserId(p) === userId);
    if (participant) {
      return { username: participant.username, encryptedProfile: participant.encryptedProfile ?? null };
    }
  }
  return undefined;
}

async function defaultContactProfile(userId: string): Promise<string | null | undefined> {
  const { getContact } = await import('@lib/contactStore');
  const contact = await getContact(userId);
  return contact?.encryptedProfile ?? null;
}

async function defaultDecryptProfile(
  userId: string,
  encryptedProfile: string
): Promise<KtSubjectProfile | null> {
  const { useProfileStore } = await import('@store/profile');
  const profile = await useProfileStore.getState().decryptAndCache(userId, encryptedProfile);
  return profile ?? null;
}

