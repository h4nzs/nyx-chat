import { useState, useEffect } from 'react';
import { useProfileStore, DecryptedProfile } from '@store/profile';
import type { UserId } from '@nyx/shared';
import i18n from '../i18n';

export function useUserProfile(userInput?: { id: string | UserId; encryptedProfile?: string | null; name?: string; avatarUrl?: string | null; description?: string | null } | UserId | null | undefined) {
  const user = typeof userInput === 'string' 
    ? { id: userInput, encryptedProfile: undefined, name: undefined, avatarUrl: undefined } 
    : userInput;

  const cacheKey = user?.encryptedProfile ? `${user.id}_${user.encryptedProfile.substring(0, 32)}` : user?.id;

  const cachedProfile = useProfileStore(s => cacheKey ? s.profiles[cacheKey] : undefined);
  const decryptAndCache = useProfileStore(s => s.decryptAndCache);
  const getCacheOnly = useProfileStore(s => s.getCacheOnly);

  const [localProfile, setLocalProfile] = useState<DecryptedProfile | null>(null);

  useEffect(() => {
    if (!user || !user.id || !user.encryptedProfile) return;

    let isMounted = true;

    const loadProfile = async () => {
        // 1. Cepat: Cek cache (RAM/IndexedDB) dulu tanpa memicu worker dekripsi
        const quickCache = await getCacheOnly(user.id, user.encryptedProfile!);
        if (isMounted && quickCache) {
          setLocalProfile(quickCache);
          return; // Jika cocok, tidak perlu lanjut ke dekripsi berat
        }

        // 2. Latar Belakang: Dekripsi penuh via worker jika cache tidak ada/lama
        const decrypted = await decryptAndCache(user.id, user.encryptedProfile!);
        if (isMounted) setLocalProfile(decrypted);
    };

    loadProfile();

    return () => { isMounted = false; };
  }, [user?.id, user?.encryptedProfile, getCacheOnly, decryptAndCache]);

  if (!user) return { name: i18n.t('common:defaults.unknown', "Unknown"), avatarUrl: null, description: null };
  if (cachedProfile) return cachedProfile; 
  if (localProfile) return localProfile;   
  
  // ✅ FIX: Jika objek 'user' sudah membawa nama (misalnya dari SQLite / cache / mapper backend), JANGAN DITOLAK!
  if (user.name && !('isPlaceholder' in user && (user as { isPlaceholder?: boolean }).isPlaceholder)) {
      return { name: user.name, avatarUrl: user.avatarUrl || null, description: user.description || null };
  }

  if (!user.encryptedProfile) return { name: i18n.t('common:defaults.anonymous', "Anonymous"), avatarUrl: null, description: null };

  return { name: i18n.t('common:defaults.encrypted_user', "Encrypted User"), avatarUrl: null, description: null };
}