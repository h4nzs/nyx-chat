import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireTenantAuth } from '../middleware/tenantAuth.js';
import { hashPassword } from '../utils/password.js';
import { signAccessToken, newJti, refreshExpiryDate } from '../utils/jwt.js';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { env } from '../config.js';
import { getSodium } from '../lib/sodium.js';
import { Buffer } from 'buffer';
import { pepperedIdentifier } from '../utils/atRestSecrets.js';

const router = Router();

// Helper to issue tokens for the iframe
async function issueIframeTokens(user: { id: string; role?: string }, req: Request) {
  const deviceName = 'NYX Engine Iframe';
  
  let device = await prisma.device.findFirst({ where: { userId: user.id, name: deviceName } });
  
  if (!device) {
    // Generate dummy keys since encryption will be handled in the iframe
    const sodium = await getSodium();
    const keyPair = sodium.crypto_sign_keypair();
    const pkBytes = keyPair.publicKey;
    const skBytes = keyPair.privateKey;
    
    device = await prisma.device.create({
      data: {
        userId: user.id,
        name: deviceName,
        publicKey: Buffer.from(pkBytes),
        signingKey: Buffer.from(pkBytes), // dummy
        encryptedPrivateKey: Buffer.from(''), // handled later if needed
      }
    });
  }

  const accessJti = newJti();
  const access = signAccessToken({ id: user.id, role: user.role, deviceId: device.id, jti: accessJti });
  const refreshJti = newJti();
  
  // [docs/28 Tier 0 — D5] ipAddress & userAgent tidak lagi disimpan (hash IP
  // tanpa kunci = enumerable, UA = sidik jari perangkat). Paritas dengan auth.ts.
  await prisma.refreshToken.create({
    data: { jti: refreshJti, deviceId: device.id, familyId: randomUUID(), expiresAt: refreshExpiryDate() }
  });

  return access;
}

router.post('/rooms', requireTenantAuth, async (req: Request, res: Response) => {
  try {
    const tenant = req.tenant!;
    const { userA, userB, metadata } = req.body;

    if (!userA?.externalId || !userB?.externalId) {
      return res.status(400).json({ error: 'userA and userB must include externalId' });
    }

    const processUser = async (u: { externalId: string, displayName?: string }) => {
      // [docs/28 Tier 0 — D6] Paritas dengan auth.ts: blind index disimpan
      // ter-pepper (deterministik per tenant+externalId, tapi tak bisa dibalik
      // dari dump DB).
      const usernameHash = pepperedIdentifier(
        crypto.createHash('sha256').update(`${tenant.id}:${u.externalId}`).digest('hex')
      );
      
      let user = await prisma.user.findUnique({
        where: { tenantId_externalId: { tenantId: tenant.id, externalId: u.externalId } }
      });

      if (!user) {
        // Generate a strong random password since they login via token
        const rawPassword = crypto.randomBytes(32).toString('hex');
        const passwordHash = await hashPassword(rawPassword);
        
        user = await prisma.user.create({
          data: {
            usernameHash,
            passwordHash,
            tenantId: tenant.id,
            externalId: u.externalId,
            isVerified: true, // Auto-verify B2B users
          }
        });
      }
      return user;
    };

    const [dbUserA, dbUserB] = await Promise.all([
      processUser(userA),
      processUser(userB)
    ]);

    // In Opaque Mailbox, we can't find a conversation by participant IDs.
    // The B2B caller must manage conversationIds locally or we always create a new one.
    const conversation = await prisma.conversation.create({
      data: {
        isGroup: false,
        tenantId: tenant.id,
        metadata: metadata || {},
      }
    });

    const [tokenA, tokenB] = await Promise.all([
      issueIframeTokens(dbUserA, req),
      issueIframeTokens(dbUserB, req)
    ]);

    const baseUrl = env.appUrl || 'https://app.nyx-app.my.id';
    
    res.json({
      userAUrl: `${baseUrl}/embed/chat/${conversation.id}?token=${tokenA}`,
      userBUrl: `${baseUrl}/embed/chat/${conversation.id}?token=${tokenB}`
    });

  } catch (error) {
    console.error('B2B Engine Room Creation Error:', error);
    res.status(500).json({ error: 'Internal server error while creating room' });
  }
});

export default router;
