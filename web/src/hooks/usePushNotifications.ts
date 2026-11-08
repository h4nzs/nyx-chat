import { useState, useEffect, useCallback, useRef } from 'react';
import { transportClient, } from '@lib/transportClient';
import { urlBase64ToUint8Array } from '@utils/url';
import toast from 'react-hot-toast';
import i18n from '../i18n';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

async function getReadyServiceWorker(timeoutMs = 1500): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

export function usePushNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(Notification.permission);
  const [isSubscribed, setIsSubscribed] = useState(() => {
    return localStorage.getItem('nyx_push_enabled') === 'true';
  });
  const [loading, setLoading] = useState(false);

  const mountedRef = useRef(true);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup retry timer on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  // Helper untuk kirim ke socket (memoized with useCallback)
  const sendSubscriptionToSocket = useCallback((subscription: PushSubscription) => {
    const socket = transportClient;
    if (!socket || !transportClient.connected) {
       // Coba lagi sebentar jika socket belum connect
       retryTimerRef.current = setTimeout(() => {
           if (!mountedRef.current) return;
           const retrySocket = transportClient;
           if (retrySocket && retrySocket.connected) {
               sendSubscriptionToSocket(subscription);
           }
       }, 2000);
       return;
    }

    const subJSON = subscription.toJSON();
    if (subJSON.endpoint && subJSON.keys?.p256dh && subJSON.keys?.auth) {
      transportClient.sendEvent('push:subscribe', {
        endpoint: subJSON.endpoint,
        keys: {
          p256dh: subJSON.keys.p256dh,
          auth: subJSON.keys.auth,
        },
      });
    }
  }, []);

  // 1. Cek status subscription saat pertama kali load
  useEffect(() => {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      getReadyServiceWorker(1500).then(registration => {
        if (!registration) return;
        registration.pushManager.getSubscription().then(subscription => {
          if (!mountedRef.current) return;
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
  }, [sendSubscriptionToSocket]);

  // 2. Fungsi Subscribe (Dipanggil saat tombol diklik)
  const subscribeToPush = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast.error(i18n.t('errors:push_notifications_not_supported', 'Push notifications not supported'));
      return;
    }

    if (!VAPID_PUBLIC_KEY) {
      console.error('VAPID Public Key is missing in .env');
      return;
    }

    setLoading(true);
    try {
      const registration = await getReadyServiceWorker(2000);
      if (!registration) {
        toast.error(i18n.t('errors:push_notifications_not_supported', 'Push notifications not supported'));
        setLoading(false);
        return;
      }
      const perm = await Notification.requestPermission();
      setPermission(perm);

      if (perm !== 'granted') {
        toast.error(i18n.t('errors:notification_permission_denied', 'Notification permission denied'));
        setLoading(false);
        return;
      }

      const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey
      });

      if (mountedRef.current) {
        sendSubscriptionToSocket(subscription);
        setIsSubscribed(true);
        localStorage.setItem('nyx_push_enabled', 'true');
        toast.success(i18n.t('common:notifications_enabled', 'Notifications enabled!'));
      }
    } catch (error: unknown) {
      console.error('Failed to subscribe:', error);
      toast.error(i18n.t('errors:failed_to_enable_notifications', `Failed to enable notifications: ${error instanceof Error ? error.message : 'Unknown error'}`, { error: error instanceof Error ? error.message : 'Unknown error' }));
      if (mountedRef.current) {
        setIsSubscribed(false);
        localStorage.removeItem('nyx_push_enabled');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [sendSubscriptionToSocket]);

  // 3. Fungsi Unsubscribe
  const unsubscribeFromPush = useCallback(async () => {
    if (!mountedRef.current) return;
    setLoading(true);
    try {
      const registration = await getReadyServiceWorker(2000);
      const subscription = registration ? await registration.pushManager.getSubscription() : null;

      if (subscription) {
        await subscription.unsubscribe();
      }

      if (mountedRef.current) {
        setIsSubscribed(false);
        localStorage.removeItem('nyx_push_enabled');

        const socket = transportClient;
        if (socket && transportClient.connected) {
          transportClient.sendEvent('push:unsubscribe');
        }

        toast.success(i18n.t('common:notifications_disabled', 'Notifications disabled'));
      }
    } catch (error) {
      console.error('Error unsubscribing', error);
      toast.error(i18n.t('errors:failed_to_disable_notifications', 'Failed to disable notifications'));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
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