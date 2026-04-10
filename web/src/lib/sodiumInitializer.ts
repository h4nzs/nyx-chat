// ✅ FIX: Kembali ke import statis. Vite akan mengamankannya lewat 'optimizeDeps' di vite.config.ts
import * as sodiumExports from 'libsodium-wrappers';

// Handle perbedaan export antara CJS/UMD dan ESM
const sodium = sodiumExports.default || sodiumExports;

let isSodiumInitialized = false;
let sodiumInitPromise: Promise<void> | null = null;

/**
 * Initializes libsodium library
 * This function ensures libsodium is properly loaded before any crypto operations
 */
export async function initializeSodium(): Promise<void> {
  if (isSodiumInitialized) {
    return;
  }

  if (sodiumInitPromise) {
    // If initialization is already in progress, wait for it
    await sodiumInitPromise;
    return;
  }

  // Gunakan promise bawaan dari library
  sodiumInitPromise = sodium.ready
    .then(() => {
      isSodiumInitialized = true;
    })
    .catch((error: unknown) => {
      console.error('Failed to initialize libsodium:', error);
      // Reset promise to allow retry on next call
      sodiumInitPromise = null;
      throw error;
    });

  await sodiumInitPromise;
}

/**
 * Gets the sodium instance after ensuring it's initialized
 */
export async function getSodium(): Promise<typeof sodium> {
  try {
    await initializeSodium();
    if (!isSodiumInitialized) {
      throw new Error('Libsodium failed to initialize');
    }
    return sodium;
  } catch (error) {
    console.error('Failed to initialize libsodium:', error);
    throw new Error('Libsodium failed to initialize: ' + (error instanceof Error ? error.message : 'Unknown error'));
  }
}

/**
 * Checks if sodium is ready for use
 */
export function isSodiumReady(): boolean {
  return isSodiumInitialized;
}
