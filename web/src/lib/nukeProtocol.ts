import { closeDatabaseConnection } from './keychainDb';

export const executeLocalWipe = async () => {
  try {
    // 0. Close active connections to release the file lock
    await closeDatabaseConnection();

    // 1. Obliterate all known IndexedDB Vaults
    let databases = ['nyx_offline_queue', 'nyx_shadow_vault'];
    
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

    // Fallback: Hardcoded legacy name just in case
    databases.push('nyx_keychain');
    
    // Try to get dynamic list if supported by browser
    if (window.indexedDB && window.indexedDB.databases) {
        try {
            const dbs = await window.indexedDB.databases();
            const names = dbs.map(db => db.name).filter((n): n is string => !!n);
            if (names.length > 0) databases = names;
        } catch (_e) {}
    }

    for (const db of databases) {
      const req = indexedDB.deleteDatabase(db);
      req.onblocked = () => {
          console.warn(`[Nuke] Database ${db} is blocked. Closing page to force release.`);
          window.location.reload();
      };
    }

    // 2. Wipe Local & Session Storage completely
    localStorage.clear();
    sessionStorage.clear();

    // 3. Unregister all Service Workers (removes PWA traces and caches)
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
      }
    }

    // 4. Wipe Cache Storage API
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        await caches.delete(name);
      }
    }

    // 5. Hard Redirect to self-destruct current memory context
    window.location.replace('/');
  } catch (e) {
    // Fallback to aggressive reload anyway
    console.error("Nuke partially failed, forcing reload:", e);
    window.location.replace('/');
  }
};