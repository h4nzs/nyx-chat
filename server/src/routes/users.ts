import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { io } from "../socket.js";
import { z } from "zod";
import { zodValidate } from "../utils/validate.js";

const router = Router();

// Konfigurasi Multer untuk upload avatar
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(process.cwd(), "uploads", "avatars");
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const userId = req.user.id;
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

// === GET: User data diri ===
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: (req as any).user.id },
      select: { id: true, email: true, username: true, name: true, avatarUrl: true, description: true, showEmailToOthers: true, hasCompletedOnboarding: true },
    });
    res.json(user);
  } catch (error) {
    next(error);
  }
});

// === PUT: Update user profile (e.g., name) ===
router.put("/me", 
  requireAuth, 
  zodValidate({ 
    body: z.object({ 
      name: z.string().min(1).trim().optional(),
      description: z.string().max(200).trim().optional(),
      showEmailToOthers: z.boolean().optional(),
    }) 
  }),
  async (req, res, next) => {
    try {
      const userId = (req as any).user.id;
      const { name, description, showEmailToOthers } = req.body;

      const dataToUpdate: { name?: string; description?: string, showEmailToOthers?: boolean } = {};
      if (name) dataToUpdate.name = name;
      if (description !== undefined) dataToUpdate.description = description;
      if (showEmailToOthers !== undefined) dataToUpdate.showEmailToOthers = showEmailToOthers;

      if (Object.keys(dataToUpdate).length === 0) {
        return res.status(400).json({ error: "No update data provided." });
      }

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: dataToUpdate,
        select: { id: true, email: true, username: true, name: true, avatarUrl: true, description: true, showEmailToOthers: true },
      });

      io.emit('user:updated', updatedUser);
      res.json(updatedUser);
    } catch (error) {
      next(error);
    }
  }
);

// === PUT: Update user's public keys ===
router.put("/me/keys",
  requireAuth,
  zodValidate({
    body: z.object({
      publicKey: z.string().min(10),
      signingKey: z.string().min(10),
    })
  }),
  async (req, res, next) => {
    try {
      const userId = req.user.id;
      const { publicKey, signingKey } = req.body;

      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          publicKey,
          signingKey,
        },
        select: { id: true, name: true },
      });
      
      // Notify other users that this user's identity has changed
      io.emit('user:identity_changed', { userId: user.id, name: user.name });

      res.status(200).json({ message: "Keys updated successfully." });
    } catch (error) {
      next(error);
    }
  }
);


// === POST: Update user avatar ===
router.post("/me/avatar", requireAuth, uploadAvatar.single('avatar'), async (req, res, next) => {
  try {
    const userId = (req as any).user.id;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
      select: { id: true, email: true, username: true, name: true, avatarUrl: true },
    });

    io.emit('user:updated', updatedUser);
    res.json(updatedUser);
  } catch (error) {
    next(error);
  }
});

// === GET: Cari user berdasarkan query ===
router.get("/search", 
  requireAuth, 
  zodValidate({ query: z.object({ q: z.string().min(1) }) }),
  async (req, res, next) => {
    try {
      const query = req.query.q as string;
      const meId = req.user.id;

      const users = await prisma.user.findMany({
        where: {
          AND: [
            { id: { not: meId } },
            {
              OR: [
                { username: { contains: query, mode: "insensitive" } },
                { name: { contains: query, mode: "insensitive" } },
              ],
            },
          ],
        },
        take: 10,
        select: {
          id: true,
          username: true,
          name: true,
          avatarUrl: true,
        },
      });

      res.json(users);
    } catch (e) {
      next(e);
    }
  }
);

// === GET: User data by ID ===
router.get(
  '/:userId',
  requireAuth,
  async (req, res, next) => {
    try {
      const { userId } = req.params;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          name: true,
          avatarUrl: true,
          description: true,
          createdAt: true,
          publicKey: true, // Include public key
          email: true, // Select email to check it
          showEmailToOthers: true, // Select the flag
        },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Conditionally build the response
      const publicProfile: any = {
        id: user.id,
        username: user.username,
        name: user.name,
        avatarUrl: user.avatarUrl,
        description: user.description,
        createdAt: user.createdAt,
        publicKey: user.publicKey, // Add public key to the response
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

// === POST: Mark onboarding as complete ===
router.post("/me/complete-onboarding", requireAuth, async (req, res, next) => {
  try {
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