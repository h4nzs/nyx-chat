import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../utils/errors.js';
import { redisClient } from '../lib/redis.js';
import crypto from 'crypto';
import { sendJsonToUser, emitEventToUser } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';
import { SubscriptionTier } from '@nyx/shared';
import { safeEqualStrings } from '../utils/validate.js';

const router: Router = Router();

// [PAYMENTS CRYPTO-ONLY] Jalur fiat (Tripay: /create + /webhook) dihapus total —
// NYX hanya menerima pembayaran kripto. Alasan: even with an anonymous alias,
// fiat rails create a financial paper trail that contradicts the zero-knowledge
// promise. NOWPayments (kripto) adalah satu-satunya jalur pembayaran.

const nowPaymentsApiKey = process.env.NOWPAYMENTS_API_KEY || '';
const nowPaymentsIpnSecret = process.env.NOWPAYMENTS_IPN_SECRET || '';

// Create Crypto Transaction (NOWPayments)
router.post('/create-crypto-transaction', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ApiError(401, 'Unauthorized');

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) throw new ApiError(404, 'User not found');

    if (user.subscriptionTier === 'SUBSCRIBER') {
      return res.status(400).json({ error: 'Already a subscriber.' });
    }

    const orderId = `NYX-PRO-${user.id}-${Date.now()}`;

    // Request to NOWPayments
    const nowPaymentsRes = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': nowPaymentsApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        price_amount: 55000,
        price_currency: 'idr',
        order_id: orderId,
        order_description: 'NYX PRO - 30 Days',
        success_url: process.env.APP_URL ? `${process.env.APP_URL}/settings` : 'https://nyx-app.my.id/settings',
        cancel_url: process.env.APP_URL ? `${process.env.APP_URL}/settings` : 'https://nyx-app.my.id/settings',
        is_fee_paid_by_user: true
      })
    });

    if (!nowPaymentsRes.ok) {
      const errText = await nowPaymentsRes.text();
      console.error('[NOWPayments] Invoice creation failed:', errText);
      throw new ApiError(500, 'Failed to create crypto invoice.');
    }

    const data = await nowPaymentsRes.json() as { invoice_url: string };

    res.json({
      invoice_url: data.invoice_url
    });

  } catch (error) {
    console.error('[NOWPayments] Create transaction error:', error);
    next(error);
  }
});

// NOWPayments Webhook
router.post('/nowpayments-webhook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    if (!signature || typeof signature !== 'string') {
      return res.status(403).json({ error: 'Missing signature' });
    }

    const payload = req.body;
    const sortedKeys = Object.keys(payload).sort();
    const sortedPayload: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      sortedPayload[key] = payload[key];
    }
    
    const stringifiedPayload = JSON.stringify(sortedPayload);

    const hmac = crypto.createHmac('sha512', nowPaymentsIpnSecret);
    hmac.update(stringifiedPayload);
    const expectedSignature = hmac.digest('hex');

    if (!safeEqualStrings(signature, expectedSignature)) {
      console.error("[NOWPayments] Invalid signature key");
      return res.status(403).json({ error: 'Invalid signature' });
    }

    const orderId = payload.order_id;
    const paymentStatus = payload.payment_status;

    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({ error: "Missing order_id" });
    }

    // Extract user ID from orderId: NYX-PRO-<USER_ID>-<TIMESTAMP>
    const orderIdParts = orderId.split('-');
    if (orderIdParts.length < 4 || orderIdParts[0] !== 'NYX' || orderIdParts[1] !== 'PRO') {
       return res.status(400).json({ error: "Invalid order ID format" });
    }
    
    const userId = orderIdParts.slice(2, orderIdParts.length - 1).join('-');

    if (paymentStatus === 'finished') {
      // Success
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      await prisma.user.update({
        where: { id: userId },
        data: { 
          subscriptionTier: SubscriptionTier.SUBSCRIBER,
          subscriptionExpiresAt: expiresAt
        }
      });

      // Emit real-time update
      await emitEventToUser(userId, 'subscription_updated', {
        tier: SubscriptionTier.SUBSCRIBER,
        expiresAt: expiresAt.toISOString()
      });

      // Clear rate limit keys from Redis
      const key = `sandbox:msg:${userId}`;
      try {
        await redisClient.del(key);
      } catch (e) {
        console.error('[Redis] Failed to clear sandbox key', e);
      }

      console.log(`[Subscription] User ${userId} upgraded to SUBSCRIBER via NOWPayments`);
    } else {
      console.log(`[Subscription] Crypto payment status ${paymentStatus} for user ${userId}`);
    }

    res.status(200).json({ message: 'OK' });
  } catch (error) {
    console.error('[NOWPayments Webhook Error]:', error);
    next(error); // Return 500
  }
});

export default router;
