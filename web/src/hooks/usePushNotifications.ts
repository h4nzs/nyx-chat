import { useState, useEffect, useCallback } from 'react';
import { getSocket } from '@lib/socket';
import { urlBase64ToUint8Array } from '@utils/url';
import toast from 'react-hot-toast';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export function usePushNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(Notification.permission);
  const [isSubscribed, setIsSubscribed] = useState(() => {
    return localStorage.getItem('nyx_push_enabled') === 'true';
  });
  const [loading, setLoading] = useState(false);

  // 1. Cek status subscription saat pertama kali load
  useEffect(() => {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      navigator.serviceWorker.ready.then(registration => {
        registration.pushManager.getSubscription().then(subscription => {
          const hasSub = !!subscription;
          setIsSubscribed(hasSub);
          
          if (hasSub) {
            localStorage.setItem('nyx_push_enabled', 'true');
            // Sinkronisasi ulang dengan server
            sendSubscriptionToSocket(subscription);
          } else {
            localStorage.removeItem('nyx_push_enabled');
          }
        });
      });
    }
  }, []);

  // Helper untuk kirim ke socket
  const sendSubscriptionToSocket = (subscription: PushSubscription) => {
    const socket = getSocket();
    if (!socket || !socket.connected) {
       // Coba lagi sebentar jika socket belum connect
       setTimeout(() => {
           const retrySocket = getSocket();
           if (retrySocket && retrySocket.connected) {
               sendSubscriptionToSocket(subscription);
           }
       }, 2000);
       return;
    }

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
  };

  // 2. Fungsi Subscribe (Dipanggil saat tombol diklik)
  const subscribeToPush = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast.error('Push notifications not supported');
      return;
    }

    if (!VAPID_PUBLIC_KEY) {
      console.error('VAPID Public Key is missing in .env');
      return;
    }

    setLoading(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      setPermission(perm);

      if (perm !== 'granted') {
        toast.error('Notification permission denied');
        setLoading(false);
        return;
      }

      const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey
      });

      sendSubscriptionToSocket(subscription);
      
      setIsSubscribed(true);
      localStorage.setItem('nyx_push_enabled', 'true');
      toast.success('Notifications enabled!');
    } catch (error: any) {
      console.error('Failed to subscribe:', error);
      toast.error('Failed to enable notifications: ' + error.message);
      setIsSubscribed(false);
      localStorage.removeItem('nyx_push_enabled');
    } finally {
      setLoading(false);
    }
  }, []);

  // 3. Fungsi Unsubscribe
  const unsubscribeFromPush = useCallback(async () => {
    setLoading(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      
      if (subscription) {
        await subscription.unsubscribe();
      }
      
      setIsSubscribed(false);
      localStorage.removeItem('nyx_push_enabled');
      
      const socket = getSocket();
      if (socket && socket.connected) {
        socket.emit('push:unsubscribe');
      }
      
      toast.success('Notifications disabled');
    } catch (error) {
      console.error('Error unsubscribing', error);
      toast.error('Failed to disable notifications');
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    permission,
    isSubscribed,
    loading,
    subscribeToPush,
    unsubscribeFromPush
  };
}