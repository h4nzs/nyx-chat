import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../utils/errors.js';
import { redisClient } from '../lib/redis.js';
import crypto from 'crypto';
import midtransClient from 'midtrans-client';

const router: Router = Router();

const isProd = process.env.NODE_ENV === 'production';
const serverKey = process.env.MIDTRANS_SERVER_KEY || 'SB-Mid-server-DUMMY';
const clientKey = process.env.MIDTRANS_CLIENT_KEY || 'SB-Mid-client-DUMMY';

let snap: any;
try {
  snap = new midtransClient.Snap({
    isProduction: isProd,
    serverKey: serverKey,
    clientKey: clientKey
  });
} catch (error) {
  console.warn("Midtrans initialization failed. Payment features may not work:", error);
}

// 1. Create Transaction (Token Request)
router.post('/create-transaction', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ApiError(401, 'Unauthorized');

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) throw new ApiError(404, 'User not found');

    if (user.subscriptionTier === 'SUBSCRIBER') {
      return res.status(400).json({ error: 'Already a subscriber.' });
    }

    // Create anonymous alias email
    const aliasEmail = `nyx_pay_${user.id}@nyx.chat`;
    const orderId = `NYX-PRO-${user.id}-${Date.now()}`;

    const parameters = {
      transaction_details: {
        order_id: orderId,
        gross_amount: 55000
      },
      customer_details: {
        first_name: "NYX User",
        email: aliasEmail
      },
      item_details: [
        {
          id: 'NYX-PRO-1M',
          price: 55000,
          quantity: 1,
          name: 'NYX PRO - 30 Days'
        }
      ]
    };

    if (!snap) {
       throw new ApiError(500, "Payment gateway not initialized.");
    }

    const transaction = await snap.createTransaction(parameters);
    
    res.json({
      token: transaction.token,
      redirect_url: transaction.redirect_url
    });

  } catch (error) {
    console.error('[Midtrans] Create transaction error:', error);
    next(error);
  }
});

// 2. Webhook Notification
router.post('/webhook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notification = req.body;
    
    if (!snap) {
        return res.status(500).json({ error: "Payment gateway not initialized." });
    }
    
    const statusResponse = await snap.transaction.notification(notification);
    
    const orderId = statusResponse.order_id;
    const transactionStatus = statusResponse.transaction_status;
    const fraudStatus = statusResponse.fraud_status;

    // Validate Signature Key
    const signatureKey = statusResponse.signature_key;
    const statusCode = statusResponse.status_code;
    const grossAmount = statusResponse.gross_amount;
    
    const expectedHash = crypto.createHash('sha512').update(`${orderId}${statusCode}${grossAmount}${serverKey}`).digest('hex');
    
    if (signatureKey !== expectedHash) {
      console.error("[Midtrans] Invalid signature key");
      return res.status(403).json({ error: 'Invalid signature' });
    }

    // Extract user ID from orderId: NYX-PRO-<USER_ID>-<TIMESTAMP>
    const orderIdParts = orderId.split('-');
    if (orderIdParts.length < 4 || orderIdParts[0] !== 'NYX' || orderIdParts[1] !== 'PRO') {
       return res.status(400).json({ error: "Invalid order ID format" });
    }
    
    // Join the parts in case user ID contains hyphens
    const userId = orderIdParts.slice(2, orderIdParts.length - 1).join('-');

    if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
      if (transactionStatus === 'capture' && fraudStatus === 'challenge') {
        // Wait for manual approval
        return res.status(200).json({ message: 'OK - Challenged' });
      } else {
        // Success
        await prisma.user.update({
          where: { id: userId },
          data: { subscriptionTier: 'SUBSCRIBER' }
        });

        // Clear rate limit keys from Redis
        const key = `sandbox:msg:${userId}`;
        try {
          await redisClient.del(key);
        } catch (e) {
          console.error('[Redis] Failed to clear sandbox key', e);
        }

        console.log(`[Subscription] User ${userId} upgraded to SUBSCRIBER`);
      }
    } else if (transactionStatus === 'cancel' || transactionStatus === 'deny' || transactionStatus === 'expire') {
      console.log(`[Subscription] Payment failed/cancelled for user ${userId}`);
    }

    res.status(200).json({ message: 'OK' });
  } catch (error) {
    console.error('[Midtrans Webhook Error]:', error);
    next(error); // Return 500
  }
});

export default router;
