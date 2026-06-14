import { db } from '../lib/db';
import { v4 as uuidv4 } from 'uuid';

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
    // Attempt to get GPU info
    (() => {
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl') as WebGLRenderingContext;
            if (!gl) return 'no-webgl';
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            return debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'no-renderer-info';
        } catch (e) { return 'error-webgl'; }
    })(),
    // Logic for fonts or hardware concurrency
    navigator.hardwareConcurrency || 'unknown',
  ].join('|');

  // Hash the signals using SHA-256 for a fixed-length ID
  const msgUint8 = new TextEncoder().encode(signals);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Gets or creates a persistent installation ID stored in IndexedDB.
 * This ID survives cache clears (unless IndexedDB is wiped) and is 
 * much more stable than Cookies or LocalStorage.
 */
export async function getPersistentInstallationId(): Promise<string> {
  try {
    const existing = await db.kvStore.get('installation_id');
    if (existing && typeof existing.value === 'string') {
      return existing.value;
    }
    
    // Create a new one if it doesn't exist
    const newId = `nyx_inst_${uuidv4()}`;
    await db.kvStore.put({ key: 'installation_id', value: newId });
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
 * Combines browser fingerprint and installation ID for maximum anti-spam strength.
 */
export async function getFullDeviceIdentity(): Promise<{ fingerprint: string, installationId: string }> {
  const [fingerprint, installationId] = await Promise.all([
    getBrowserFingerprint(),
    getPersistentInstallationId()
  ]);
  
  return { fingerprint, installationId };
}
