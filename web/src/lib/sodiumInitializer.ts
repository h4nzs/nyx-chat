import sodium from 'libsodium-wrappers';

// Flag to track if sodium has been initialized
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

  sodiumInitPromise = sodium.ready
    .then(() => {
      isSodiumInitialized = true;
      console.log('Libsodium initialized successfully');
    })
    .catch((error) => {
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