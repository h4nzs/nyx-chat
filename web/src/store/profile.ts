import { createWithEqualityFn } from 'zustand/traditional';
import { decryptProfile } from '@lib/crypto-worker-proxy';
import { getProfileKey } from '@lib/keychainDb';
import { db } from '@lib/db';
import type { UserId } from '@nyx/shared';

export type DecryptedProfile = {
  name: string;
  username?: string; // Added field
  description?: string | null;
  avatarUrl?: string | null;
  autoDestructDays?: number | null; // Added field
};

type ProfileState = {
  profiles: Record<string, DecryptedProfile>;
  decryptAndCache: (userId: string | UserId, encryptedProfile: string | null) => Promise<DecryptedProfile>;
  getCacheOnly: (userId: string | UserId, encryptedProfile: string | null) => Promise<DecryptedProfile | null>;
};

/**
 * [FIX UI ANONYMOUS 2026-10-05] Selain key komposit `${id}_${epHash}` (kontrak
 * lama semua pemanggil), dekripsi yang SUKSES juga ditulis ke ALIAS plain-id.
 * Alasan: banyak UI (useUserProfile untuk participant tanpa encryptedProfile,
 * ContactRow untuk kontak tanpa ep) hanya bisa membaca key polos — dulu
 * mereka tak pernah melihat hasil dekripsi → nama/avatar jatuh ke
 * "Anonymous"/"Encrypted User" TANPA error console sama sekali.
 * Alias adalah derived cache: tidak menambah permukaan privasi (isi RAM sama,
 * hidup-hidupnya mengikuti proses/tab yang sama).
 */
export const useProfileStore = createWithEqualityFn<ProfileState>((set, get) => ({
  profiles: {},

  getCacheOnly: async (userId, encryptedProfile): Promise<DecryptedProfile | null> => {
    if (!encryptedProfile) return null;
    const cacheKey = `${userId}_${encryptedProfile.substring(0, 32)}`;

    // 1. Check RAM (key komposit, lalu alias plain-id — sama-sama valid):
    // alias aman di sini karena pemanggil getCacheOnly TIDAK akan mendekripsi
    // (tanpa ep → null balik), jadi tidak ada risiko menyematkan profil basa.
    const cached = get().profiles[cacheKey] ?? get().profiles[String(userId)];
    if (cached) return cached;

    // 2. Check IndexedDB
    const idbCache = await db.profileCache.get(userId);
    if (idbCache && idbCache.encryptedHash === encryptedProfile) {
      const parsed: DecryptedProfile = {
        name: idbCache.name,
        avatarUrl: idbCache.avatarUrl,
        description: idbCache.description
      };
      // Populate RAM (komposit + alias plain-id)
      set((state) => ({ profiles: { ...state.profiles, [cacheKey]: parsed, [String(userId)]: parsed } }));
      return parsed;
    }
    return null;
  },

  decryptAndCache: async (userId, encryptedProfile) => {
    // 1. Generate composite cache key
    const cacheKey = encryptedProfile ? `${userId}_${encryptedProfile.substring(0, 32)}` : userId;
    const idKey = String(userId);

    // 2. Return RAM cache if exists. PEMANGGIL DENGAN ep: HANYA komposit yang
    // boleh short-circuit — alias bisa basa (ep peer sudah berganti), dan
    // pemanggil ber-ep justru membawa versi TERBARU yang wajib di-decrypt.
    // Alias hanya untuk pemanggil TANPA ep (cacheKey === idKey).
    const cached = get().profiles[cacheKey] ?? (encryptedProfile ? undefined : get().profiles[idKey]);
    if (cached) return cached;

    // 3. Default fallback
    const fallback: DecryptedProfile = { name: "Encrypted User" };
    if (!encryptedProfile) return fallback;

    // 4. Try Persistent Cache (IndexedDB)
    const idbCache = await db.profileCache.get(userId);
    if (idbCache && idbCache.encryptedHash === encryptedProfile) {
      const parsed: DecryptedProfile = {
        name: idbCache.name,
        avatarUrl: idbCache.avatarUrl,
        description: idbCache.description
      };
      set((state) => ({ profiles: { ...state.profiles, [cacheKey]: parsed, [idKey]: parsed } }));
      return parsed;
    }

    try {
      // 5. Cari ProfileKey di IndexedDB
      const profileKey = await getProfileKey(userId);
      if (!profileKey) return fallback;

      // 6. Decrypt via Worker
      const jsonString = await decryptProfile(encryptedProfile, profileKey);
      const parsed = JSON.parse(jsonString) as DecryptedProfile;

      // 7. Save to RAM — key komposit + alias plain-id (UI keyed polos ikut kebagian)
      set((state) => ({ profiles: { ...state.profiles, [cacheKey]: parsed, [idKey]: parsed } }));

      // 8. Save to IndexedDB
      await db.profileCache.put({
        id: userId as UserId,
        name: parsed.name,
        avatarUrl: parsed.avatarUrl || null,
        description: parsed.description || null,
        encryptedHash: encryptedProfile,
        updatedAt: Date.now()
      });

      return parsed;
    } catch (e) {
      console.error(`Failed to decrypt profile for ${userId}`, e);
      return fallback;
    }
  }
}), Object.is);

/**
 * [FIX UI ANONYMOUS 2026-10-05] Hydrator untuk UI yang TIDAK punya
 * encryptedProfile (participant panel grup, kontak tanpa ep):
 *   1. RAM alias plain-id sudah dijamin oleh decryptAndCache/getCacheOnly;
 *   2. Kalau kosong → cek profileCache IndexedDB (enkripsi tak perlu — IDB
 *      profil dianggap cache aman oleh arsitektur profile store);
 *   3. Kalau ada ep dari pemanggil → coba dekripsi penuh (satu kali).
 * Memanggil set() hanya bila memang menemukan profil (tidak spam re-render).
 */
export async function hydrateProfileForPlainId(userId: string | UserId, encryptedProfile?: string | null): Promise<DecryptedProfile | null> {
  const store = useProfileStore.getState();
  const idKey = String(userId);
  const direct = store.profiles[idKey];
  if (direct) return direct;

  const idbCache = await db.profileCache.get(userId).catch(() => undefined);
  if (idbCache) {
    const parsed: DecryptedProfile = {
      name: idbCache.name,
      avatarUrl: idbCache.avatarUrl,
      description: idbCache.description
    };
    useProfileStore.setState((state) => ({
      profiles: state.profiles[idKey] ? state.profiles : { ...state.profiles, [idKey]: parsed },
    }));
    return parsed;
  }

  if (encryptedProfile) {
    return store.decryptAndCache(userId, encryptedProfile);
  }
  return null;
}
