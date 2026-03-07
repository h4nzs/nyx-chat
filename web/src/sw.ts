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
           const idb = await import('idb-keyval');
           const encryptedKeys = await idb.get('nyx_encrypted_keys');
           const autoUnlockKey = await idb.get('nyx_device_auto_unlock_key');

           if (encryptedKeys && autoUnlockKey) {
              const sodium = await import('libsodium-wrappers').then(s => { s.default.ready; return s.default; });
              const { argon2id } = await import('hash-wasm');

              // Reproduce KDF logic to unlock private keys (simplified for SW)
              const salt = sodium.from_string("nyx_salt");
              const masterSeed = await argon2id({
                  password: autoUnlockKey,
                  salt,
                  parallelism: 1,
                  iterations: 2,
                  memorySize: 65536,
                  hashLength: 32,
                  outputType: 'binary'
              });

              // Decrypt the identity key pair
              const encryptedKeysBytes = sodium.from_base64(encryptedKeys, sodium.base64_variants.URLSAFE_NO_PADDING);
              const nonce = encryptedKeysBytes.slice(0, 24);
              const ctext = encryptedKeysBytes.slice(24);
              
              const decryptedKeysBytes = sodium.crypto_secretbox_open_easy(ctext, nonce, masterSeed);
              const keysJson = sodium.to_string(decryptedKeysBytes);
              const keys = JSON.parse(keysJson);
              
              const privateKey = sodium.from_base64(keys.identityKeyPair.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING);
              const publicKey = sodium.from_base64(keys.identityKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
              
              // Open the Sealed Box
              const sealedPayloadBytes = sodium.from_base64(data.data.encryptedPushPayload, sodium.base64_variants.URLSAFE_NO_PADDING);
              const decryptedPushBytes = sodium.crypto_box_seal_open(sealedPayloadBytes, publicKey, privateKey);
              
              const decryptedPayload = JSON.parse(sodium.to_string(decryptedPushBytes));
              
              title = decryptedPayload.title || title;
              body = decryptedPayload.body || body;
              conversationId = decryptedPayload.conversationId || conversationId;
              
              sodium.memzero(masterSeed);
              sodium.memzero(privateKey);
           }
        } catch (cryptoError) {
           console.error("[SW] Push decryption failed, falling back to generic payload:", cryptoError);
        }
      }

      const options: any = {
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
      };

      await self.registration.showNotification(title, options);
    } catch (err) {
      console.error('Error handling push event:', err);
    }
  })());
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();

  const conversationId = event.notification.data?.conversationId;
  // Sesuaikan routing frontend kamu
  const targetUrl = conversationId ? `/chat/${conversationId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus().then((focusedClient) => {
            if ('navigate' in focusedClient) {
              return focusedClient.navigate(targetUrl);
            }
          });
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});