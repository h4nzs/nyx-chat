import { useState, useEffect } from 'react';
import { useProfileStore, DecryptedProfile } from '@store/profile';
import type { UserId } from '@nyx/shared';

// Menerima object user yang memiliki id dan encryptedProfile ATAU UserId langsung
export function useUserProfile(userInput?: { id: string | UserId; encryptedProfile?: string | null } | UserId | null | undefined) {
  // Normalize input
  const user = typeof userInput === 'string' 
    ? { id: userInput, encryptedProfile: undefined } 
    : userInput;

  // Generate composite cache key
  const cacheKey = user?.encryptedProfile ? `${user.id}_${user.encryptedProfile.substring(0, 32)}` : user?.id;

  // ✅ SUPER OPTIMASI: Hanya berlangganan (subscribe) ke spesifik 1 kunci profil ini saja!
  const cachedProfile = useProfileStore(s => cacheKey ? s.profiles[cacheKey] : undefined);
  const decryptAndCache = useProfileStore(s => s.decryptAndCache);

  // Default data (Sebelum dekripsi / jika tidak punya kunci)
  const [localProfile, setLocalProfile] = useState<DecryptedProfile | null>(null);

  useEffect(() => {
    if (!user || cachedProfile || !user.encryptedProfile) return;
    
    let isMounted = true;

    const loadProfile = async () => {
        // Suruh store decrypt (async) - INI AKAN MENGECEK IDB
        const decrypted = await decryptAndCache(user.id, user.encryptedProfile!);
        if (isMounted) setLocalProfile(decrypted);
    };

    loadProfile();

    return () => { isMounted = false; };
  }, [user?.id, user?.encryptedProfile, cachedProfile, decryptAndCache]);

  // ✅ Kembalikan data dengan hierarki prioritas
  if (!user) return { name: "Unknown", avatarUrl: null, description: null };
  if (cachedProfile) return cachedProfile; // 1. Prioritaskan RAM (Zustand Cache) - O(1) Instan!
  if (localProfile) return localProfile;   // 2. Gunakan state lokal jika baru di-decrypt
  if (!user.encryptedProfile) return { name: "Anonymous", avatarUrl: null, description: null };

  // 3. Status loading saat sedang mendekripsi
  return { name: "Encrypted User", avatarUrl: null, description: null };
}