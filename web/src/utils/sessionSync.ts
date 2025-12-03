import { authFetch } from "@lib/api";
import { getMyEncryptionKeyPair, decryptSessionKeyForUser } from "@utils/crypto";
import { addSessionKey } from "@lib/keychainDb";
import toast from "react-hot-toast";

type SyncResponse = Record<string, { sessionId: string; encryptedKey: string }[]>;

export async function syncSessionKeys() {
  await toast.promise(
    (async () => {
      try {
        console.log("Starting session key synchronization...");

        const allEncryptedKeys = await authFetch<SyncResponse>("/api/session-keys/sync");
        if (!allEncryptedKeys || Object.keys(allEncryptedKeys).length === 0) {
          console.log("No session keys to sync.");
          return;
        }

        const { publicKey, privateKey } = await getMyEncryptionKeyPair();
        let syncedKeyCount = 0;

        for (const conversationId in allEncryptedKeys) {
          const keysForConvo = allEncryptedKeys[conversationId];
          for (const keyInfo of keysForConvo) {
            try {
              const sessionKey = await decryptSessionKeyForUser(
                keyInfo.encryptedKey,
                publicKey,
                privateKey
              );
              await addSessionKey(conversationId, keyInfo.sessionId, sessionKey);
              syncedKeyCount++;
            } catch (decryptionError) {
              console.warn(`Failed to decrypt session key ${keyInfo.sessionId} for convo ${conversationId}. Skipping.`, decryptionError);
            }
          }
        }

        console.log(`Synchronization complete. Synced ${syncedKeyCount} session keys.`);
      } catch (error: any) {
        console.error("Session key synchronization failed:", error);
        if (error.message.includes("Incorrect password")) {
          throw new Error("Incorrect password provided for key sync.");
        }
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