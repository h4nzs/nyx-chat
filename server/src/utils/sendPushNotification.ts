import webpush from 'web-push'
import { prisma } from '../lib/prisma.js'
import { env } from '../config.js'
// [docs/28 Tier 1.5 / D10] endpoint push tersimpan ter-seal.
import { openAtRest } from './atRestSecrets.js'
import { redisClient } from '../lib/redis.js'
import { createPushLinkToken, type PushLinkStore } from './pushLink.js'

export interface PushNotificationPayload {
  type?: string;
  /** Server-only: dipakai membuat token deep link, TIDAK pernah diserialisasi. */
  conversationId?: string;
  data?: {
    encryptedPushPayload?: string;
    pushPayloadMap?: Record<string, string>;
  };
}

/**
 * [docs/43 §43.16.2 T3] Payload push TIDAK memuat `conversationId`/`messageId`:
 * FCM/APNs (dan operatornya) tidak boleh bisa mengorelasikan perangkat,
 * percakapan, dan irama pesan. Isi pesan tetap opaque di
 * `encryptedPushPayload`; aplikasi yang membukanya.
 */
export function buildPushPayload(
  payload: PushNotificationPayload,
  devicePayload: string | undefined,
  linkToken?: string
) {
  const data: { encryptedPushPayload?: string; pushToken?: string } = {};
  if (devicePayload) data.encryptedPushPayload = devicePayload;
  // Token opaque per pengiriman per subscription — bukan id percakapan.
  if (linkToken) data.pushToken = linkToken;
  return {
    title: 'New Secure Message',
    body: 'You received a new encrypted message.',
    type: devicePayload ? 'ENCRYPTED_MESSAGE' : (payload.type || 'GENERIC_MESSAGE'),
    data,
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

      const linkToken = payload.conversationId
        ? await createPushLinkToken(redisClient as unknown as PushLinkStore, {
            userId,
            subscriptionId: sub.id,
            conversationId: payload.conversationId,
          })
        : null;
      const safePayload = buildPushPayload(payload, devicePayload, linkToken ?? undefined);

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
