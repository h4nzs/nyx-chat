import webpush from 'web-push'
import { prisma } from '../lib/prisma.js'
import { env } from '../config.js'

export async function sendPushNotification (userId: string, payload: any) {
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
      ).catch((error: any) => {
        // Jika subscription tidak valid (misal: user uninstall app), hapus dari DB
        if (error.statusCode === 410 || error.statusCode === 404) {
          return prisma.pushSubscription.delete({ where: { id: sub.id } })
        }
        console.error(`Error sending push notification for sub ${sub.id}: statusCode=${error?.statusCode || 'unknown'}`);
      })
    )

    await Promise.all(notifications)
  } catch (error: any) {
    console.error(`Failed to send push notifications: statusCode=${error?.statusCode || 'unknown'}`);
  }
}
