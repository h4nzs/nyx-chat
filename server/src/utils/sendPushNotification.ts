import webpush from 'web-push'
import { prisma } from '../lib/prisma.js'
import { env } from '../config.js'
// [docs/28 Tier 1.5 / D10] endpoint push tersimpan ter-seal.
import { openAtRest } from './atRestSecrets.js'

export interface PushNotificationPayload {
  type?: string;
  data?: {
    conversationId?: string;
    messageId?: string;
    encryptedPushPayload?: string;
    pushPayloadMap?: Record<string, string>;
  };
}

export async function sendPushNotification(userId: string, payload: PushNotificationPayload) {
  if (!env.vapidPublicKey || !env.vapidPrivateKey) {
    return; // Do nothing if VAPID keys are missing
  }

  try {
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { device: { userId } },
      // [docs/28 Tier 1.5 / D10] endpoint tersimpan ter-seal.
      select: { id: true, deviceId: true, p256dh: true, auth: true, endpointSealed: true }
    });
    
    if (subscriptions.length === 0) return;

    const notifications = subscriptions.map(async (sub) => {
      // Endpoint asli hanya dibutuhkan di sini (mengirim push) — dibuka saat itu.
      const endpoint = await openAtRest(sub.endpointSealed);
      if (!endpoint) return;
      let devicePayload = payload.data?.pushPayloadMap?.[sub.deviceId] || payload.data?.encryptedPushPayload;

      if (devicePayload && Buffer.byteLength(devicePayload, 'utf8') > 3000) {
        devicePayload = undefined;
      }

      const safePayload = {
        title: "New Secure Message",
        body: "You received a new encrypted message.",
        type: devicePayload ? 'ENCRYPTED_MESSAGE' : (payload.type || 'GENERIC_MESSAGE'),
        data: {
          conversationId: payload.data?.conversationId,
          messageId: payload.data?.messageId,
          encryptedPushPayload: devicePayload
        }
      };

      try {
        await webpush.sendNotification(
          {
            endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth }
          },
          JSON.stringify(safePayload)
        );
      } catch (error) {
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? (error as Record<string, unknown>).statusCode : undefined;
        if (statusCode === 410 || statusCode === 404) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else {
          console.error(`Error sending push notification for sub ${sub.id}: statusCode=${statusCode || 'unknown'}`);
        }
      }
    });

    await Promise.all(notifications);
  } catch (error) {
    console.error('Error broadcasting push notification:', error);
  }
}
