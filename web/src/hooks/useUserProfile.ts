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
    
    let isMounted = true;

    const loadProfile = async () => {
        // Jika sudah ada di memori RAM, langsung pakai
        if (profiles[user.id]) {
            setProfile(profiles[user.id]);
            return;
        }

        // Jika belum, suruh store decrypt (async) - INI AKAN MENGECEK IDB
        if (user.encryptedProfile) {
            const decrypted = await decryptAndCache(user.id, user.encryptedProfile);
            if (isMounted) setProfile(decrypted);
        } else {
            if (isMounted) setProfile({ name: "Anonymous" }); // Jika user belum setup profil
        }
    };

    loadProfile();

    return () => { isMounted = false; };
  }, [user?.id, user?.encryptedProfile, profiles]); // Depend on profiles to trigger re-render when cache updates

  return profile;
}
