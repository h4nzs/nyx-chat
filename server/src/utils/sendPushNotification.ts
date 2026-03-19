import webpush from 'web-push'
import { prisma } from '../lib/prisma.js'
import { env } from '../config.js'

export interface PushNotificationPayload {
  type?: string;
  data?: {
    conversationId?: string;
    messageId?: string;
    encryptedPushPayload?: string;
  };
}

export async function sendPushNotification (userId: string, payload: PushNotificationPayload) {
  if (!env.vapidPublicKey || !env.vapidPrivateKey) {
    return // Jangan lakukan apa-apa jika VAPID keys tidak ada
  }

  try {
    const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } })
    if (subscriptions.length === 0) return

    let encryptedPushPayload = payload['data']?.encryptedPushPayload;
    if (encryptedPushPayload && Buffer.byteLength(encryptedPushPayload, 'utf8') > 3000) {
      // If the encrypted payload exceeds safe limits (Web Push limit is ~4KB),
      // fallback to metadata-only to ensure delivery.
      encryptedPushPayload = undefined;
    }

    const safePayload = {
      title: "New Secure Message",
      body: "You received a new encrypted message.",
      type: payload.type || 'GENERIC_MESSAGE',
      data: {
        conversationId: payload['data']?.conversationId,
        messageId: payload['data']?.messageId,
        encryptedPushPayload
      }
    };
    const payloadString = JSON.stringify(safePayload);

    const notifications = subscriptions.map(sub =>
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        },
        payloadString
      ).catch((error: unknown) => {
        // Jika subscription tidak valid (misal: user uninstall app), hapus dari DB
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? (error as Record<string, unknown>).statusCode : undefined;
        if (statusCode === 410 || statusCode === 404) {
          return prisma.pushSubscription.delete({ where: { id: sub.id } })
        }
        console.error(`Error sending push notification for sub ${sub.id}: statusCode=${statusCode || 'unknown'}`);
      })
    )

    await Promise.all(notifications)
  } catch (error: unknown) {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? (error as Record<string, unknown>).statusCode : undefined;
    console.error(`Failed to send push notifications: statusCode=${statusCode || 'unknown'}`);
  }
}
