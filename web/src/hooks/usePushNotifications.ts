import { useEffect } from 'react'
import { getSocket } from '@lib/socket'

// Check if push notifications are supported
export function usePushNotifications() {
  useEffect(() => {
    // Check if service worker is supported
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      // Register service worker
      navigator.serviceWorker.register('/sw.js')
        .then(registration => {
          console.log('Service Worker registered:', registration);
          
          // Check if push notifications are enabled
          registration.pushManager.getSubscription()
            .then(subscription => {
              if (subscription) {
                // Send subscription to server
                const socket = getSocket();
                const subJSON = subscription.toJSON();
                if (subJSON.endpoint && subJSON.keys?.p256dh && subJSON.keys?.auth) {
                  socket.emit('push:subscribe', {
                    endpoint: subJSON.endpoint,
                    keys: {
                      p256dh: subJSON.keys.p256dh,
                      auth: subJSON.keys.auth,
                    },
                  });
                }
              }
            });
        })
        .catch(error => {
          console.error('Service Worker registration failed:', error);
        });
    }
  }, []);
}

// Request push notification permission
export async function requestPushPermission() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push notifications are not supported');
  }

  // Register service worker
  const registration = await navigator.serviceWorker.register('/sw.js');
  
  // Request permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Permission not granted');
  }

  // Subscribe to push notifications
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: import.meta.env.VITE_VAPID_PUBLIC_KEY
  });

  // Send subscription to server
  const socket = getSocket();
  const subJSON = subscription.toJSON();
    if (subJSON.endpoint && subJSON.keys?.p256dh && subJSON.keys?.auth) {
        socket.emit('push:subscribe', {
        endpoint: subJSON.endpoint,
        keys: {
            p256dh: subJSON.keys.p256dh,
            auth: subJSON.keys.auth,
        },
        });
    }

  return subscription;
}

// Unsubscribe from push notifications
export async function unsubscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration();
  if (registration) {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
      
      // Notify server
      const socket = getSocket();
      socket.emit('push:unsubscribe');
    }
  }
}
