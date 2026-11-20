import { getKvStore } from '../lib/storage/appKv';
const uuidv4 = () => crypto.randomUUID();

/**
 * Generates a consistent browser fingerprint based on hardware and browser signals.
 * This is a lightweight implementation that doesn't track users across sites, 
 * but provides a stable ID for anti-spam in NYX.
 */
export async function getBrowserFingerprint(): Promise<string> {
  const signals = [
    navigator.userAgent,
    navigator.language,
    new Date().getTimezoneOffset(),
    screen.colorDepth,
    screen.width + 'x' + screen.height,
    navigator.hardwareConcurrency || 'unknown',
    navigator.deviceMemory || 'unknown',
    navigator.maxTouchPoints || 0,
    // Kita gunakan resolusi layar yang tersedia (mengabaikan taskbar/dock) untuk stabilitas lebih tinggi
    screen.availWidth + 'x' + screen.availHeight,
  ].join('|');

  // Hash the signals using SHA-256 for a fixed-length ID.
  // Guard: crypto.subtle bisa melempar (mis. konteks tidak aman / proteksi
  // fingerprint browser) — rejection tak ter-tangani akan memutus flow koneksi.
  const msgUint8 = new TextEncoder().encode(signals);
  try {
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (_e) {
    // Fallback stabil (djb2) bila crypto.subtle diblokir environment
    let hash = 5381;
    for (let i = 0; i < msgUint8.length; i++) {
      hash = ((hash << 5) + hash + msgUint8[i]!) | 0;
    }
    return 'fp_' + (hash >>> 0).toString(16).padStart(8, '0');
  }
}

/**
 * Gets or creates a persistent installation ID stored in IndexedDB.
 * This ID survives cache clears (unless IndexedDB is wiped) and is 
 * much more stable than Cookies or LocalStorage.
 */
export async function getPersistentInstallationId(): Promise<string> {
  try {
    const existing = await (await getKvStore()).get<string>('installation_id');
    if (existing && typeof existing === 'string') {
      return existing;
    }
    
    // Create a new one if it doesn't exist
    const newId = `nyx_inst_${uuidv4()}`;
    await (await getKvStore()).put({ key: 'installation_id', value: newId });
    return newId;
  } catch (e) {
    console.warn("[Fingerprint] Failed to access IndexedDB, falling back to LocalStorage:", e);
    // Fallback to LocalStorage
    let lsId = localStorage.getItem('nyx_installation_id');
    if (!lsId) {
      lsId = `nyx_ls_${uuidv4()}`;
      localStorage.setItem('nyx_installation_id', lsId);
    }
    return lsId;
  }
}

/**
 * Combines browser fingerprint and installation ID for maximum security binding.
 * Returns both separately so the server can decide how to handle mismatches.
 */
export async function getFullDeviceIdentity(): Promise<{ fingerprint: string, installationId: string }> {
  const [fingerprint, installationId] = await Promise.all([
    getBrowserFingerprint(),
    getPersistentInstallationId()
  ]);
  
  return { fingerprint, installationId };
}
