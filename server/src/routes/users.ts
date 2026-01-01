import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { getIo } from "../socket.js";
import { z } from "zod";
import { zodValidate } from "../utils/validate.js";
import { ApiError } from "../utils/errors.js";

const router = Router();

// This middleware will apply to all routes in this file
router.use(requireAuth);

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(process.cwd(), "uploads", "avatars");
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // req.user is guaranteed to be present by requireAuth middleware
    const userId = req.user!.id;
    const extension = path.extname(file.originalname);
    cb(null, `${userId}${extension}`);
  },
});

const uploadAvatar = multer({ 
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const mimeType = allowedTypes.test(file.mimetype);
    const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    if (mimeType && extName) {
      return cb(null, true);
    }
    cb(new Error('Only image files (jpeg, jpg, png, gif) are allowed!'));
  }
});

router.get("/me", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, username: true, name: true, avatarUrl: true, description: true, showEmailToOthers: true, hasCompletedOnboarding: true },
    });
    res.json(user);
  } catch (error) {
    next(error);
  }
});

router.put("/me", 
  zodValidate({ 
    body: z.object({ 
      name: z.string().min(1).trim().optional(),
      description: z.string().max(200).trim().optional(),
      showEmailToOthers: z.boolean().optional(),
    }) 
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, "Authentication required.");
      const { name, description, showEmailToOthers } = req.body;
      const dataToUpdate: { name?: string; description?: string, showEmailToOthers?: boolean } = {};
      if (name) dataToUpdate.name = name;
      if (description !== undefined) dataToUpdate.description = description;
      if (showEmailToOthers !== undefined) dataToUpdate.showEmailToOthers = showEmailToOthers;

      if (Object.keys(dataToUpdate).length === 0) {
        return res.status(400).json({ error: "No update data provided." });
      }

      const updatedUser = await prisma.user.update({
        where: { id: req.user.id },
        data: dataToUpdate,
        select: { id: true, email: true, username: true, name: true, avatarUrl: true, description: true, showEmailToOthers: true },
      });

      getIo().emit('user:updated', updatedUser);
      res.json(updatedUser);
    } catch (error) {
      next(error);
    }
  }
);

const base64UrlRegex = /^[A-Za-z0-9_-]+$/;
router.put("/me/keys",
  zodValidate({
    body: z.object({
      publicKey: z.string().min(43).max(256).regex(base64UrlRegex, { message: "Invalid public key format." }),
      signingKey: z.string().min(43).max(256).regex(base64UrlRegex, { message: "Invalid signing key format." }),
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, "Authentication required.");
      const userId = req.user.id;
      const { publicKey, signingKey } = req.body;

      const user = await prisma.user.update({
        where: { id: userId },
        data: { publicKey, signingKey },
        select: { id: true, name: true },
      });
      
      const conversations = await prisma.conversation.findMany({
        where: { participants: { some: { userId: userId } } },
        include: { participants: { select: { userId: true } } },
      });

      const recipients = new Set<string>();
      conversations.forEach(c => c.participants.forEach(p => {
        if (p.userId !== userId) recipients.add(p.userId);
      }));

      recipients.forEach(recipientId => {
        getIo().to(recipientId).emit('user:identity_changed', { userId: user.id, name: user.name });
      });

      res.status(200).json({ message: "Keys updated successfully." });
    } catch (error) {
      next(error);
    }
  }
);

router.post("/me/avatar", uploadAvatar.single('avatar'), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: { avatarUrl },
      select: { id: true, email: true, username: true, name: true, avatarUrl: true },
    });

    getIo().emit('user:updated', updatedUser);
    res.json(updatedUser);
  } catch (error) {
    next(error);
  }
});

router.get("/search", 
  zodValidate({ query: z.object({ q: z.string().min(1) }) }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, "Authentication required.");
      const query = req.query.q as string;
      const meId = req.user.id;

      const users = await prisma.user.findMany({
        where: {
          AND: [
            { id: { not: meId } },
            { OR: [
                { username: { contains: query, mode: "insensitive" } },
                { name: { contains: query, mode: "insensitive" } },
              ],
            },
          ],
        },
        take: 10,
        select: { id: true, username: true, name: true, avatarUrl: true },
      });
      res.json(users);
    } catch (e) {
      next(e);
    }
  }
);

router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true, username: true, name: true, avatarUrl: true, description: true,
          createdAt: true, publicKey: true, email: true, showEmailToOthers: true,
        },
      });

      if (!user) return res.status(404).json({ error: 'User not found' });

      const publicProfile: Partial<typeof user> & { id: string } = {
        id: user.id, username: user.username, name: user.name,
        avatarUrl: user.avatarUrl, description: user.description,
        createdAt: user.createdAt, publicKey: user.publicKey,
      };

      if (user.showEmailToOthers) {
        publicProfile.email = user.email;
      }

      res.json(publicProfile);
    } catch (error) {
      next(error);
    }
  }
);

router.post("/me/complete-onboarding", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    await prisma.user.update({
      where: { id: req.user.id },
      data: { hasCompletedOnboarding: true },
    });
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
