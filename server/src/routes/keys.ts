import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { z } from "zod";
import { zodValidate } from "../utils/validate.js";

const router = Router();

// === POST: Upload/update a user's pre-key bundle ===
router.post(
  "/prekey-bundle",
  requireAuth,
  zodValidate({
    body: z.object({
      identityKey: z.string(),
      signedPreKey: z.object({
        key: z.string(),
        signature: z.string(),
      }),
    }),
  }),
  async (req, res, next) => {
    try {
      const userId = req.user.id;
      const { identityKey, signedPreKey } = req.body;

      // Use a transaction to ensure both operations succeed or fail together
      await prisma.$transaction([
        prisma.preKeyBundle.upsert({
          where: { userId },
          update: {
            identityKey,
            key: signedPreKey.key,
            signature: signedPreKey.signature,
          },
          create: {
            userId,
            identityKey,
            key: signedPreKey.key,
            signature: signedPreKey.signature,
          },
        }),
        prisma.user.update({
          where: { id: userId },
          data: { publicKey: identityKey },
        }),
      ]);

      res.status(201).json({ message: "Pre-key bundle updated successfully." });
    } catch (e) {
      next(e);
    }
  }
);

// === GET: Get a pre-key bundle for another user ===
router.get(
  "/prekey-bundle/:userId",
  requireAuth,
  zodValidate({ params: z.object({ userId: z.string().cuid() }) }),
  async (req, res, next) => {
    try {
      const { userId } = req.params;

      const userWithBundle = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          signingKey: true, // Needed by the recipient to verify the signature
          preKeyBundle: true,
        },
      });

      if (!userWithBundle?.preKeyBundle || !userWithBundle.signingKey) {
        throw new Error("User does not have a valid pre-key bundle available.");
      }
      
      const { preKeyBundle, signingKey } = userWithBundle;

      // Assemble the response bundle
      const responseBundle = {
        identityKey: preKeyBundle.identityKey,
        signedPreKey: {
          key: preKeyBundle.key,
          signature: preKeyBundle.signature,
        },
        signingKey: signingKey, // Include the public signing key for verification
      };

      res.json(responseBundle);
    } catch (e: any) {
      if (e.message.includes("pre-key bundle")) {
        return res.status(404).json({ error: e.message });
      }
      next(e);
    }
  }
);

// === GET: Get an initial session key record for a recipient ===
router.get(
  "/initial-session/:conversationId/:sessionId",
  requireAuth,
  zodValidate({
    params: z.object({
      conversationId: z.string(),
      sessionId: z.string(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { conversationId, sessionId } = req.params;
      const userId = req.user.id;

      const keyRecord = await prisma.sessionKey.findFirst({
        where: {
          conversationId,
          sessionId,
          userId,
        },
      });

      if (!keyRecord || !keyRecord.initiatorEphemeralKey) {
        return res.status(404).json({ error: "Initial session data not found for this user." });
      }

      // Find the initiator to get their public identity key
      const initiatorRecord = await prisma.sessionKey.findFirst({
        where: {
          conversationId,
          sessionId,
          isInitiator: true
        },
        include: { user: { select: { id: true, publicKey: true } } },
      });

      if (!initiatorRecord?.user?.publicKey) {
        return res.status(404).json({ error: "Initiator's public key could not be found for this session." });
      }

      res.json({
        encryptedKey: keyRecord.encryptedKey,
        initiatorEphemeralKey: keyRecord.initiatorEphemeralKey,
        initiatorIdentityKey: initiatorRecord.user.publicKey,
      });

    } catch (e) {
      next(e);
    }
  }
);

export default router;