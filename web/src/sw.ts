/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;

import { cleanupOutdatedCaches, precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';
import { createMutexRegistry, handleMutexRequest, type MutexRequest } from './lib/swMutexCore';

// 1. Lifecycle Management
self.skipWaiting();
clientsClaim();

// 2. Cleanup Old Caches
cleanupOutdatedCaches();

// 3. Precache Resources
precacheAndRoute(self.__WB_MANIFEST);

// 3b. Navigation fallback (app shell) — saat server/jaringan mati, navigasi tetap
// dilayani dari index.html yang di-precache, sehingga SPA bisa boot dan menampilkan
// ServerDownPage sendiri. Hanya shell statis; API/uploads TIDAK pernah di-cache
// (lihat poin 4). Denylist memastikan endpoint server tidak pernah dibalas shell.
try {
  registerRoute(
    new NavigationRoute(createHandlerBoundToURL('/index.html'), {
      denylist: [/^\/api(\/|$)/, /^\/api-docs/, /^\/\.well-known\//, /^\/uploads\//],
    }),
  );
} catch (err) {
  // Mode dev: index.html belum ada di manifest precache → lewati, jangan matikan SW.
  console.warn('[sw] navigation fallback dinonaktifkan:', err);
}

// 4. API Caching Strategy - REMOVED FOR PRIVACY (No caching of sensitive data)

// --- 4b. Mutex lintas-tab (mutual exclusion sejati untuk browser tanpa Web
// Locks) — registry di sini TUNGGAL per-origin: semua tab berbicara dengan
// instance SW yang sama. Semantik registry: lib/swMutexCore.ts (heartbeat +
// sweep stale → tab crash otomatis kehilangan lock dalam LOCK_STALE_MS).
const mutexRegistry = createMutexRegistry();

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { __nyxMutex?: boolean; id?: number; req?: MutexRequest } | undefined;
  if (!data || data.__nyxMutex !== true || !data.req || typeof data.id !== 'number') return;
  const response = handleMutexRequest(mutexRegistry, data.req);
  // Balas via port MessageChannel yang dibawa event (dibuka klien di
  // swMutexClient.ts). Echo id agar klien bisa mencocokkan balasan.
  event.source?.postMessage({ ...response, id: data.id });
});

// --- 5. Push Notification Logic ---

self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return;

  event.waitUntil((async () => {
    try {
      const data = event.data?.json();
      if (!data) return;
      
      let title = data.title || 'New message';
      let body = data.body || 'You have a new message';
      // [docs/43 T3] token opaque per pengiriman; dipakai untuk deep link tanpa
      // membocorkan id percakapan ke provider push. Diletakkan di HASH supaya
      // tidak ikut terkirim ke server sebagai query/access log.
      const pushToken = data.data?.pushToken;

      // NOTE: E2EE push decryption is handled in the main app when user opens it.
      // Service Worker avoids heavy crypto libraries (libsodium, hash-wasm) to
      // stay within browser SW size limits (~1 MB). Push notifications show
      // generic content; app-side decryption provides the real message.
      // [docs/43 §43.16.2 T3] Payload server tidak lagi memuat id percakapan,
      // jadi SW tidak bisa memilih chat — notifikasi hanya sinyal "ada pesan".
      if (data.type === 'ENCRYPTED_MESSAGE') {
        // For encrypted pushes, use generic fallback title
        title = data.title || 'New secure message';
        body = data.body || 'You have a new end-to-end encrypted message';
      }

      const options: NotificationOptions = {
        body,
        icon: '/nyx.png', 
        badge: '/nyx.png',
        data: {
          url: pushToken ? `/chat#push=${encodeURIComponent(pushToken)}` : '/chat',
        },
        tag: 'nyx-message',
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

  // [docs/43 T3] token opaque (bila ada) membawa deep link tanpa id percakapan;
  // tanpa token, buka daftar chat seperti biasa.
  const targetPath = typeof event.notification.data?.url === 'string'
    ? event.notification.data.url
    : '/chat';
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
