import { createWithEqualityFn } from 'zustand/traditional';
import { decryptProfile } from '@lib/crypto-worker-proxy';
import { getProfileKey } from '@lib/keychainDb';

export type DecryptedProfile = {
  name: string;
  description?: string | null;
  avatarUrl?: string | null;
  autoDestructDays?: number | null; // Added field
};

type ProfileState = {
  profiles: Record<string, DecryptedProfile>;
  decryptAndCache: (userId: string, encryptedProfile: string | null) => Promise<DecryptedProfile>;
};

export const useProfileStore = createWithEqualityFn<ProfileState>((set, get) => ({
  profiles: {},
  decryptAndCache: async (userId, encryptedProfile) => {
    // 1. Generate composite cache key to prevent stale data if profile changes
    const cacheKey = encryptedProfile ? `${userId}_${encryptedProfile.substring(0, 32)}` : userId;

    // 2. Return cache if exists
    if (get().profiles[cacheKey]) return get().profiles[cacheKey];
    
    // 3. Default fallback
    const fallback: DecryptedProfile = { name: "Encrypted User" };
    if (!encryptedProfile) return fallback;

    try {
      // 4. Cari ProfileKey di IndexedDB
      const profileKey = await getProfileKey(userId);
      if (!profileKey) return fallback;

      // 5. Decrypt via Worker
      const jsonString = await decryptProfile(encryptedProfile, profileKey);
      const parsed = JSON.parse(jsonString) as DecryptedProfile;
      
      // 6. Save to RAM
      set((state) => ({ profiles: { ...state.profiles, [cacheKey]: parsed } }));
      return parsed;
    } catch (e) {
      console.error(`Failed to decrypt profile for ${userId}`, e);
      return fallback;
    }
  }
}), Object.is);
