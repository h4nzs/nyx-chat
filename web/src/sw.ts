/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

// 1. Lifecycle Management
self.skipWaiting();
clientsClaim();

// 2. Cleanup Old Caches
cleanupOutdatedCaches();

// 3. Precache Resources
precacheAndRoute(self.__WB_MANIFEST);

// 4. API Caching Strategy - REMOVED FOR PRIVACY (No caching of sensitive data)
// registerRoute(
//   ({ url }) => url.pathname.startsWith('/api/conversations'),
//   new StaleWhileRevalidate({
//     cacheName: 'api-conversations-cache',
//     plugins: [
//       new CacheableResponsePlugin({
//         statuses: [0, 200],
//       }),
//     ],
//   })
// );

// --- 5. Push Notification Logic ---

self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return;

  event.waitUntil((async () => {
    try {
      const data = event.data?.json();
      if (!data) return;
      
      let title = data.title || 'New message';
      let body = data.body || 'You have a new message';
      let conversationId = data.data?.conversationId;

      // ATTEMPT E2EE DECRYPTION FOR SEALED BOXES
      if (data.type === 'ENCRYPTED_MESSAGE' && data.data?.encryptedPushPayload) {
        try {
           // Helper to read from NyxUnifiedDB directly without heavy deps
           const getKvValue = (key: string): Promise<unknown> => {
             return new Promise((resolve) => {
               const req = indexedDB.open('NyxUnifiedDB');
               req.onsuccess = () => {
                 const db = req.result;
                 if (!db.objectStoreNames.contains('kvStore')) {
                   resolve(undefined);
                   return;
                 }
                 const tx = db.transaction('kvStore', 'readonly');
                 const store = tx.objectStore('kvStore');
                 const getReq = store.get(key);
                 getReq.onsuccess = () => resolve(getReq.result?.value);
                 getReq.onerror = () => resolve(undefined);
               };
               req.onerror = () => resolve(undefined);
             });
           };

           const encryptedKeys = (await getKvValue('nyx_encrypted_keys')) as string | undefined;
           const autoUnlockKey = (await getKvValue('nyx_device_auto_unlock_key')) as string | undefined;

           if (encryptedKeys && autoUnlockKey) {
           const sodiumModule = await import('libsodium-wrappers');
           await sodiumModule.default.ready;
           const sodium = sodiumModule.default;

           const { argon2id } = await import('hash-wasm');

           // 1. Parse the Vault Format: "saltB64.JSON_String"
           const parts = encryptedKeys.split('.');
           if (parts.length === 2) {
               const salt = sodium.from_base64(parts[0], sodium.base64_variants.URLSAFE_NO_PADDING);
               const encryptedString = parts[1];

               // 2. Derive Key matching crypto.worker.ts EXACTLY
               const kek = await argon2id({
                   password: autoUnlockKey,
                   salt,
                   parallelism: 1,
                   iterations: 3,
                   memorySize: 32768,
                   hashLength: 32,
                   outputType: 'binary'
               });

               // 3. Decrypt the Private Keys using Libsodium xchacha20poly1305_ietf
               const parsedData = JSON.parse(encryptedString);
               const iv = new Uint8Array(parsedData.iv);
               const ciphertext = new Uint8Array(parsedData.data);

               // Handle keys derived from argon2id that might be represented differently
               const keyBytes = new Uint8Array(kek as unknown as ArrayBuffer);

               const decryptedContent = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                   null,
                   ciphertext,
                   null,
                   iv,
                   keyBytes
               );

               const decryptedString = new TextDecoder().decode(decryptedContent);
               const parsedOnce = JSON.parse(decryptedString);
               // Handle the double-stringified payload from crypto.worker.ts
               const keys = typeof parsedOnce === 'string' ? JSON.parse(parsedOnce) : parsedOnce;

               // 4. Extract the Encryption Private Key & Compute Public Key
               const privateKey = sodium.from_base64(keys.encryption, sodium.base64_variants.URLSAFE_NO_PADDING);

                  const publicKey = sodium.crypto_scalarmult_base(privateKey);

                  // 5. Open the Push Notification Sealed Box
                  const sealedPayloadBytes = sodium.from_base64(data.data.encryptedPushPayload, sodium.base64_variants.URLSAFE_NO_PADDING);
                  const decryptedPushBytes = sodium.crypto_box_seal_open(sealedPayloadBytes, publicKey, privateKey);
                  
                  const decryptedPayload = JSON.parse(sodium.to_string(decryptedPushBytes));
                  
                  title = decryptedPayload.title || title;
                  body = decryptedPayload.body || body;
                  conversationId = decryptedPayload.conversationId || conversationId;

                  // Cleanup memory
                  sodium.memzero(kek);
                  sodium.memzero(privateKey);
              }
           }
        } catch (cryptoError) {
           console.error("[SW] Push decryption failed, falling back to generic payload:", cryptoError);
        }
      }

      // --- VISIBILITY CHECK ---
      // Prevent OS notification if the user is actively viewing this specific chat
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      let isFocusedOnChat = false;

      for (const client of clientList) {
        // Check if the tab is in the foreground
        if (client.visibilityState === 'visible') {
          const clientUrl = new URL(client.url);
          // Check if the user is on this exact conversation page
          if (conversationId && clientUrl.pathname.includes(`/chat/${conversationId}`)) {
            isFocusedOnChat = true;
            break;
          }
        }
      }

      if (isFocusedOnChat) {
        console.log('[SW] User is active in this chat. Suppressing OS notification.');
        return; // Abort showing notification
      }
      // --- END VISIBILITY CHECK ---

      const options: NotificationOptions = {
        body,
        icon: '/nyx.png', 
        badge: '/nyx.png',
        data: {
          conversationId,
          url: conversationId ? `/chat/${conversationId}` : '/'
        },
        tag: conversationId || 'general-message',
        renotify: true,
        vibrate: [100, 50, 100], 
      } as NotificationOptions;

      await self.registration.showNotification(title, options);
    } catch (err) {
      console.error('Error handling push event:', err);
    }
  })());
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();

  const conversationId = event.notification.data?.conversationId;
  const targetPath = conversationId ? `/chat/${conversationId}` : '/';
  // Use absolute URL for openWindow to ensure correct behavior across browsers
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      // 1. Try to find an existing window/tab of the app
      for (const client of clientList) {
        const clientUrl = new URL(client.url);
        
        // If the client origin matches our origin
        if (clientUrl.origin === self.location.origin) {
          // Focus the window
          if ('focus' in client) {
            const focusedClient = await client.focus();
            
            // 2. Tell the SPA to navigate to the correct route internally
            // This prevents a full page reload if the app is already open
            focusedClient?.postMessage({ 
              type: 'PWA_ROUTER_NAVIGATE', 
              url: targetPath 
            });
            return;
          }
        }
      }

      // 3. Fallback: No existing window found, open a new one (or launch the PWA)
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })
  );
});