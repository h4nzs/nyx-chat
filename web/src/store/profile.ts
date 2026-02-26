import { createWithEqualityFn } from 'zustand/traditional';
import { decryptProfile } from '@lib/crypto-worker-proxy';
import { getProfileKey } from '@lib/keychainDb';

export type DecryptedProfile = {
  name: string;
  description?: string | null;
  avatarUrl?: string | null;
};

type ProfileState = {
  profiles: Record<string, DecryptedProfile>;
  decryptAndCache: (userId: string, encryptedProfile: string | null) => Promise<DecryptedProfile>;
};

export const useProfileStore = createWithEqualityFn<ProfileState>((set, get) => ({
  profiles: {},
  decryptAndCache: async (userId, encryptedProfile) => {
    // 1. Return cache if exists
    if (get().profiles[userId]) return get().profiles[userId];
    
    // 2. Default fallback
    const fallback: DecryptedProfile = { name: "Encrypted User" };
    if (!encryptedProfile) return fallback;

    try {
      // 3. Cari ProfileKey di IndexedDB
      const profileKey = await getProfileKey(userId);
      if (!profileKey) return fallback;

      // 4. Decrypt via Worker
      const jsonString = await decryptProfile(encryptedProfile, profileKey);
      const parsed = JSON.parse(jsonString) as DecryptedProfile;
      
      // 5. Save to RAM
      set((state) => ({ profiles: { ...state.profiles, [userId]: parsed } }));
      return parsed;
    } catch (e) {
      console.error(`Failed to decrypt profile for ${userId}`, e);
      return fallback;
    }
  }
}), Object.is);
