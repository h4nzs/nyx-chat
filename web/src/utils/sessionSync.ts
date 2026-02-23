import { authFetch } from "@lib/api";
import { getSodium } from "@lib/sodiumInitializer";
import { addSessionKey } from "@lib/keychainDb";
import toast from "react-hot-toast";

type SyncResponse = Record<string, { sessionId: string; encryptedKey: string }[]>;

export async function syncSessionKeys() {
  await toast.promise(
    (async () => {
      try {
        const allEncryptedKeys = await authFetch<SyncResponse>("/api/session-keys/sync");
        if (!allEncryptedKeys || Object.keys(allEncryptedKeys).length === 0) {
          return;
        }

        const sodium = await getSodium();
        let syncedKeyCount = 0;

        for (const conversationId in allEncryptedKeys) {
          const keysForConvo = allEncryptedKeys[conversationId];
          for (const keyInfo of keysForConvo) {
            try {
              // [FIX] Store encrypted blob directly.
              // Server stores keys encrypted with Master Seed (symmetric).
              // IndexedDB expects the same format. No re-encryption needed.
              const encryptedKeyBytes = sodium.from_base64(
                keyInfo.encryptedKey, 
                sodium.base64_variants.URLSAFE_NO_PADDING
              );
              
              await addSessionKey(conversationId, keyInfo.sessionId, encryptedKeyBytes);
              syncedKeyCount++;
            } catch (e) {
              console.error("Failed to save synced key:", e);
            }
          }
        }
      } catch (error: any) {
        console.error("Session key synchronization failed:", error);
        throw new Error("Failed to sync message keys from server.");
      }
    })(),
    {
      loading: "Syncing message keys...",
      success: "Message keys synced successfully!",
      error: (err) => err.message || "Key synchronization failed.",
    }
  );
}