import { isPlainObject } from '@utils/typeGuards';
import { closeDatabaseConnection } from './keychainDb';

/**
 * NUCLEAR LOCAL WIPE
 * Obliterates all traces of the user from this browser.
 * This is used for Panic Password, Emergency Eject, and Account Deletion.
 */
export const executeLocalWipe = async (redirectUrl: string = '/') => {
  try {
    console.warn("INITIATING NUCLEAR LOCAL WIPE...");

    // 0.0 Matikan sesi di SERVER dulu (best-effort). Cookie `at`/`rt` HttpOnly
    // tidak bisa dihapus dari document.cookie — tanpa ini access token tetap valid
    // ~15 menit setelah wipe, sehingga "obliterate" tidak benar-benar total.
    try {
      const csrfRes = await fetch('/api/csrf-token', { credentials: 'include' });
      const csrfData = await csrfRes.json().catch(() => null) as { csrfToken?: string } | null;
      await fetch('/api/auth/logout-all', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'CSRF-Token': csrfData?.csrfToken ?? '',
          'x-nyx-installation-id': localStorage.getItem('nyx_installation_id') ?? ''
        }
      });
    } catch (_e) {
      // Session kill gagal (mungkin sudah logout / offline) — lanjutkan wipe lokal
    }

    // 0. Close active connections to release the file lock
    await closeDatabaseConnection().catch(() => {});

    // 0.5 Revoke all in-memory blob: URLs (decrypted media cache)
    try {
      const { clearBlobCache } = await import('@utils/blobCache');
      clearBlobCache();
    } catch (_e) {}

    // 0.6 Wipe OPFS (encrypted attachment cache)
    try {
      const { wipeOPFS } = await import('./opfsStorage');
      await wipeOPFS();
    } catch (_e) {}

    // 1. Obliterate all known IndexedDB Vaults
    const databases = ['nyx_offline_queue', 'nyx_shadow_vault', 'NyxUnifiedDB', 'nyx_keychain', 'NyxDB'];
    
    // Get correct keychain DB name from local storage if available
    try {
        const savedUser = localStorage.getItem("user");
        if (savedUser) {
            const _parsedUser = JSON.parse(savedUser); const user = isPlainObject(_parsedUser) ? _parsedUser : null;
            if (user?.id) {
                databases.push(`keychain-db-${user.id}`);
            }
        }
    } catch (_e) {}
    
    // Try to get dynamic list if supported by browser
    if (window.indexedDB && window.indexedDB.databases) {
        try {
            const dbs = await window.indexedDB.databases();
            dbs.forEach(db => { if (db.name) databases.push(db.name); });
        } catch (_e) {}
    }

    // Deduplicate and delete
    const uniqueDbs = Array.from(new Set(databases));
    for (const dbName of uniqueDbs) {
      console.log(`[Nuke] Deleting DB: ${dbName}`);
      const req = indexedDB.deleteDatabase(dbName);
      req.onblocked = () => {
          console.warn(`[Nuke] Database ${dbName} is blocked. Force-reloading page.`);
          window.location.reload();
      };
    }

    // 2. Wipe Bio Vault (WebAuthn PRF Storage) — semua credential (map v2 + legacy)
    import('./biometricUnlock').then(m => m.clearAllBioVaults()).catch(() => {
      localStorage.removeItem('nyx_bio_vault_v2');
      localStorage.removeItem('nyx_bio_vault');
    });

    // 3. Wipe Local & Session Storage completely
    localStorage.clear();
    sessionStorage.clear();

    // 3.5 Wipe cookies (access/refresh token & CSRF) — semua domain & path yang relevan
    try {
      const cookieNames = document.cookie.split(';').map(c => c.split('=')[0]?.trim()).filter(Boolean);
      for (const name of cookieNames) {
        for (const domain of ['', 'nyx-app.my.id', '.nyx-app.my.id']) {
          const domainPart = domain ? `; domain=${domain}` : '';
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domainPart}`;
        }
      }
    } catch (_e) {}

    // 4. Unregister all Service Workers (removes PWA traces and caches)
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
      }
    }

    // 5. Wipe Cache Storage API
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        await caches.delete(name);
      }
    }

    console.warn("LOCAL WIPE COMPLETE.");

    // 6. Hard Redirect to self-destruct current memory context
    window.location.replace(redirectUrl);
  } catch (e) {
    // Fallback to aggressive reload anyway
    console.error("Nuke partially failed, forcing reload:", e);
    window.location.replace(redirectUrl);
  }
};