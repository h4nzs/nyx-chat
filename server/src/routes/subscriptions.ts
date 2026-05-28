import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../utils/errors.js';
import { redisClient } from '../lib/redis.js';
import crypto from 'crypto';
import { getIo } from '../socket.js';
import { SubscriptionTier } from '@nyx/shared';

const router: Router = Router();

const nowPaymentsApiKey = process.env.NOWPAYMENTS_API_KEY || '';
const nowPaymentsIpnSecret = process.env.NOWPAYMENTS_IPN_SECRET || '';

// 1. Create Transaction (Tripay Checkout)
router.post('/create', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ApiError(401, 'Unauthorized');

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) throw new ApiError(404, 'User not found');

    if (user.subscriptionTier === 'SUBSCRIBER') {
      return res.status(400).json({ error: 'Already a subscriber.' });
    }

    const amount = 55000;
    const merchantRef = `NYX-PRO-${user.id}-${Date.now()}`;
    const privateKey = process.env.TRIPAY_PRIVATE_KEY || '';
    const merchantCode = process.env.TRIPAY_MERCHANT_CODE || '';
    const apiKey = process.env.TRIPAY_API_KEY || '';

    // Generate Signature Tripay
    const signature = crypto.createHmac('sha256', privateKey)
      .update(merchantCode + merchantRef + amount)
      .digest('hex');

    const payload = {
      method: req.body.method || 'QRIS', // Method can be passed from frontend, default to QRIS
      merchant_ref: merchantRef,
      amount: amount,
      customer_name: 'NYX User',
      customer_email: `nyx_pay_${user.id}@nyx.chat`,
      order_items: [
        {
          sku: 'NYX-PRO-1M',
          name: 'NYX PRO - 30 Days',
          price: amount,
          quantity: 1
        }
      ],
      return_url: process.env.APP_URL ? `${process.env.APP_URL}/settings` : 'https://nyx-app.my.id/settings',
      expired_time: Math.floor(Date.now() / 1000) + (24 * 60 * 60),
      signature: signature
    };

    const tripayRes = await fetch('https://tripay.co.id/api/transaction/create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await tripayRes.json();

    if (!data.success) {
       console.error('[Tripay] Error:', data);
       throw new ApiError(500, data.message || 'Payment creation failed');
    }

    res.json({
      checkout_url: data.data.checkout_url
    });

  } catch (error) {
    console.error('[Tripay] Create transaction error:', error);
    next(error);
  }
});

// 2. Webhook Notification (Tripay Callback)
router.post('/webhook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.headers['x-callback-signature'];
    const privateKey = process.env.TRIPAY_PRIVATE_KEY || '';

    // Verify signature
    const expectedHash = crypto.createHmac('sha256', privateKey)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (signature !== expectedHash) {
      console.error("[Tripay] Invalid signature key");
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const { status, merchant_ref } = req.body;

    if (status === 'PAID') {
      // Extract user ID from orderId: NYX-PRO-<USER_ID>-<TIMESTAMP>
      const orderIdParts = merchant_ref.split('-');
      if (orderIdParts.length < 4 || orderIdParts[0] !== 'NYX' || orderIdParts[1] !== 'PRO') {
         return res.status(400).json({ error: "Invalid order ID format" });
      }
      
      const userId = orderIdParts.slice(2, orderIdParts.length - 1).join('-');

      // Update subscription status
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
      getIo().to(userId).emit('subscription_updated', {
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

      console.log(`[Subscription] User ${userId} upgraded to SUBSCRIBER via Tripay`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Tripay Webhook Error]:', error);
    next(error);
  }
});

// 3. Create Crypto Transaction (NOWPayments)
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

// 4. NOWPayments Webhook
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

    if (signature !== expectedSignature) {
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
      getIo().to(userId).emit('subscription_updated', {
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
