import webpush from "web-push";
import { prisma } from "../lib/prisma.js";
import { env } from "../config.js";

interface PushPayload {
  title: string;
  body: string;
  conversationId?: string; // Tambahkan ini
  [key: string]: any;
}

export async function sendPushNotification(userId: string, payload: object) {
  if (!env.vapidPublicKey || !env.vapidPrivateKey) {
    return; // Jangan lakukan apa-apa jika VAPID keys tidak ada
  }

  try {
    const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
    if (subscriptions.length === 0) return;

    const payloadString = JSON.stringify(payload);

    const notifications = subscriptions.map(sub => 
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payloadString
      ).catch(error => {
        // Jika subscription tidak valid (misal: user uninstall app), hapus dari DB
        if (error.statusCode === 410 || error.statusCode === 404) {
          console.log("Push subscription has expired or is invalid. Deleting.");
          return prisma.pushSubscription.delete({ where: { id: sub.id } });
        }
        console.error("Error sending push notification:", error);
      })
    );

    await Promise.all(notifications);

  } catch (error) {
    console.error("Failed to send push notifications:", error);
  }
}
