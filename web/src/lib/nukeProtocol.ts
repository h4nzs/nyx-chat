import { closeDatabaseConnection } from './keychainDb';

/**
 * NUCLEAR LOCAL WIPE
 * Obliterates all traces of the user from this browser.
 * This is used for Panic Password, Emergency Eject, and Account Deletion.
 */
export const executeLocalWipe = async (redirectUrl: string = '/') => {
  try {
    console.warn("INITIATING NUCLEAR LOCAL WIPE...");

    // 0. Close active connections to release the file lock
    await closeDatabaseConnection().catch(() => {});

    // 1. Obliterate all known IndexedDB Vaults
    const databases = ['nyx_offline_queue', 'nyx_shadow_vault', 'NyxUnifiedDB', 'nyx_keychain', 'NyxDB'];
    
    // Get correct keychain DB name from local storage if available
    try {
        const savedUser = localStorage.getItem("user");
        if (savedUser) {
            const user = JSON.parse(savedUser);
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

    // 2. Wipe Bio Vault (WebAuthn PRF Storage)
    localStorage.removeItem('nyx_bio_vault');

    // 3. Wipe Local & Session Storage completely
    localStorage.clear();
    sessionStorage.clear();

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