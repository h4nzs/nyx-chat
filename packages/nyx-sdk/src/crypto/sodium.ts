import _sodium from 'libsodium-wrappers';

// Handle difference between environments if needed
const sodium = _sodium;

let isSodiumInitialized = false;
let sodiumInitPromise: Promise<void> | null = null;

/**
 * Initializes libsodium library
 * This function ensures libsodium is properly loaded before any crypto operations
 */
export async function initSodium(): Promise<void> {
  if (isSodiumInitialized) {
    return;
  }

  if (sodiumInitPromise) {
    await sodiumInitPromise;
    return;
  }

  sodiumInitPromise = sodium.ready
    .then(() => {
      isSodiumInitialized = true;
    })
    .catch((error: unknown) => {
      console.error('Failed to initialize libsodium:', error);
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
    await initSodium();
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
