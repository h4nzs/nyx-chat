export const executeLocalWipe = async () => {
  try {
    // 1. Obliterate all known IndexedDB Vaults
    const databases = ['nyx_keychain', 'nyx_offline_queue', 'nyx_shadow_vault'];
    for (const db of databases) {
      indexedDB.deleteDatabase(db);
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