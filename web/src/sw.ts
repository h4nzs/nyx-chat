/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope;

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import { registerRoute } from 'workbox-routing';
import { StaleWhileRevalidate } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

// 1. Lifecycle Management
self.skipWaiting();
clientsClaim();

// 2. Cleanup Old Caches
cleanupOutdatedCaches();

// 3. Precache Resources
precacheAndRoute(self.__WB_MANIFEST);

// 4. API Caching Strategy
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/conversations'),
  new StaleWhileRevalidate({
    cacheName: 'api-conversations-cache',
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200],
      }),
    ],
  })
);

// --- 5. Push Notification Logic ---

self.addEventListener('push', (event: PushEvent) => {
  console.log('Service Worker: Push Received.');
  
  if (!event.data) return;

  try {
    const data = event.data.json();
    const title = data.title || 'New message';
    
    // FIX: Gunakan 'any' untuk bypass pengecekan ketat TypeScript
    // Browser support 'renotify' dan 'vibrate', tapi definisi TS sering telat update.
    const options: any = {
      body: data.body || 'You have a new message',
      icon: '/pwa-192x192.png', 
      badge: '/pwa-192x192.png',
      data: {
        conversationId: data.conversationId,
        url: data.conversationId ? `/conversations/${data.conversationId}` : '/'
      },
      tag: data.conversationId || 'general-message',
      renotify: true,
      vibrate: [100, 50, 100], 
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error('Error handling push event:', err);
  }
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