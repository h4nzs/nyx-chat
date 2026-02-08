import { useState, useEffect, useCallback } from 'react';
import { getSocket } from '@lib/socket';
import { urlBase64ToUint8Array } from '@utils/url'; // Pastikan path ini benar
import toast from 'react-hot-toast';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export function usePushNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(Notification.permission);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);

  // 1. Cek status subscription saat pertama kali load
  useEffect(() => {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      navigator.serviceWorker.ready.then(registration => {
        registration.pushManager.getSubscription().then(subscription => {
          setIsSubscribed(!!subscription);
          // Sinkronisasi ulang dengan server jika sudah subscribe di browser tapi server lupa
          if (subscription) {
            sendSubscriptionToSocket(subscription);
          }
        });
      });
    }
  }, []);

  // Helper untuk kirim ke socket
  const sendSubscriptionToSocket = (subscription: PushSubscription) => {
    const socket = getSocket();
    if (!socket || !socket.connected) return;

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
      // Register SW jika belum
      const registration = await navigator.serviceWorker.ready;
      await navigator.serviceWorker.ready;

      // Request Permission Browser
      const perm = await Notification.requestPermission();
      setPermission(perm);

      if (perm !== 'granted') {
        toast.error('Notification permission denied');
        setLoading(false);
        return;
      }

      // FIX UTAMA: Konversi Key String -> Uint8Array
      const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);

      // Lakukan Subscribe ke Browser Push Manager
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey // Gunakan key hasil konversi
      });

      // Kirim ke Backend via Socket
      sendSubscriptionToSocket(subscription);
      
      setIsSubscribed(true);
      toast.success('Notifications enabled!');
    } catch (error: any) {
      console.error('Failed to subscribe:', error);
      toast.error('Failed to enable notifications: ' + error.message);
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
        setIsSubscribed(false);
        
        // Beritahu server via socket
        const socket = getSocket();
        if (socket && socket.connected) {
          socket.emit('push:unsubscribe'); // Pastikan backend handle event ini (opsional)
        }
        
        toast.success('Notifications disabled');
      }
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