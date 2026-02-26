import { useState, useEffect } from 'react';
import { useProfileStore, DecryptedProfile } from '@store/profile';

// Menerima object user yang memiliki id dan encryptedProfile
export function useUserProfile(user?: { id: string; encryptedProfile?: string | null } | null) {
  const { profiles, decryptAndCache } = useProfileStore();
  
  // Default data (Sebelum dekripsi / jika tidak punya kunci)
  const [profile, setProfile] = useState<DecryptedProfile>({ 
    name: user ? "Encrypted User" : "Unknown",
    avatarUrl: null,
    description: null
  });

  useEffect(() => {
    if (!user) return;
    
    // Jika sudah ada di memori RAM, langsung pakai
    if (profiles[user.id]) {
      setProfile(profiles[user.id]);
      return;
    }

    // Jika belum, suruh store decrypt (async)
    if (user.encryptedProfile) {
      decryptAndCache(user.id, user.encryptedProfile).then(setProfile);
    } else {
      setProfile({ name: "Anonymous" }); // Jika user belum setup profil
    }
  }, [user, user?.encryptedProfile, profiles, decryptAndCache]);

  return profile;
}
