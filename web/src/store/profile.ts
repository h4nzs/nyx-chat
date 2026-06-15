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

export const useProfileStore = createWithEqualityFn<ProfileState>((set, get) => ({
  profiles: {},

  getCacheOnly: async (userId, encryptedProfile) => {
    if (!encryptedProfile) return null;
    const cacheKey = `${userId}_${encryptedProfile.substring(0, 32)}`;
    
    // 1. Check RAM
    if (get().profiles[cacheKey]) return get().profiles[cacheKey];

    // 2. Check IndexedDB
    const idbCache = await db.profileCache.get(userId as string);
    if (idbCache && idbCache.encryptedHash === encryptedProfile) {
      const parsed: DecryptedProfile = {
        name: idbCache.name,
        avatarUrl: idbCache.avatarUrl,
        description: idbCache.description
      };
      // Populate RAM
      set((state) => ({ profiles: { ...state.profiles, [cacheKey]: parsed } }));
      return parsed;
    }
    return null;
  },

  decryptAndCache: async (userId, encryptedProfile) => {
    // 1. Generate composite cache key
    const cacheKey = encryptedProfile ? `${userId}_${encryptedProfile.substring(0, 32)}` : userId;

    // 2. Return RAM cache if exists
    if (get().profiles[cacheKey]) return get().profiles[cacheKey];
    
    // 3. Default fallback
    const fallback: DecryptedProfile = { name: "Encrypted User" };
    if (!encryptedProfile) return fallback;

    // 4. Try Persistent Cache (IndexedDB)
    const idbCache = await db.profileCache.get(userId as string);
    if (idbCache && idbCache.encryptedHash === encryptedProfile) {
      const parsed: DecryptedProfile = {
        name: idbCache.name,
        avatarUrl: idbCache.avatarUrl,
        description: idbCache.description
      };
      set((state) => ({ profiles: { ...state.profiles, [cacheKey]: parsed } }));
      return parsed;
    }

    try {
      // 5. Cari ProfileKey di IndexedDB
      const profileKey = await getProfileKey(userId as string);
      if (!profileKey) return fallback;

      // 6. Decrypt via Worker
      const jsonString = await decryptProfile(encryptedProfile, profileKey);
      const parsed = JSON.parse(jsonString) as DecryptedProfile;
      
      // 7. Save to RAM
      set((state) => ({ profiles: { ...state.profiles, [cacheKey]: parsed } }));

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
