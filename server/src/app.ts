import express, { Express, Request, Response, NextFunction } from "express";

declare global {
  namespace Express {
    interface Request {
      csrfToken(): string;
    }
  }
}

import cookieParser from "cookie-parser";
import logger from "morgan";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import csrf from "csurf";
import { env } from "./config.js";
import path from "path";

import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import conversationsRouter from "./routes/conversations.js";
import messagesRouter from "./routes/messages.js";
import uploadsRouter from "./routes/uploads.js";
import keysRouter from "./routes/keys.js";
import previewsRouter from "./routes/previews.js";
import sessionKeysRouter from "./routes/sessionKeys.js";
import sessionsRouter from "./routes/sessions.js";
import webpush from "web-push";

// Set VAPID keys for web-push notifications
if (process.env.VAPID_SUBJECT && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn("⚠️ VAPID keys not configured. Push notifications will be disabled.");
}

const app: Express = express();

// PENTING: Trust proxy agar cookies 'secure' bekerja di balik Render/Nginx
app.set('trust proxy', 1);

// === SECURITY / CORS ===
const isProd = env.nodeEnv === 'production';

// Ambil origin untuk WebSocket secara dinamis
let wsOrigin = 'ws://localhost:4000';
if (env.appUrl) {
  try {
    const url = new URL(env.appUrl);
    // Gunakan wss:// untuk koneksi https://
    wsOrigin = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
  } catch (e) {
    console.error("Invalid APP_URL provided for CSP:", env.appUrl);
  }
}

// Gunakan Helmet untuk header keamanan dasar
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Izinkan akses dari domain ngrok dan localhost
      scriptSrc: ["'self'", isProd ? '' : "'unsafe-eval'", "https://*.ngrok-free.app"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Diperlukan untuk styling dinamis
      // Tambahkan vercel.app agar gambar user profile bisa diload
      imgSrc: ["'self'", "data:", "blob:", "https://*.ngrok-free.app", "https://*.vercel.app"],
      // Tambahkan vercel.app agar websocket/api bisa connect
      connectSrc: ["'self'", wsOrigin, "https://*.ngrok-free.app", "wss://*.ngrok-free.app", "https://*.vercel.app", "wss://*.vercel.app"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"], // Mencegah clickjacking
      ...(isProd && { upgradeInsecureRequests: [] }),
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Izinkan resource (gambar) di-load lintas origin
}));

// Hapus header X-Powered-By
app.disable('x-powered-by');

// PERBAIKAN UTAMA: Dynamic CORS Origin
const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    // Kita percayakan semua request dari Vercel
    if (origin.endsWith('.vercel.app') || origin.endsWith('.onrender.com') || origin.includes('localhost')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "CSRF-Token"],
});

app.use(corsMiddleware);

if (isProd) {
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000, // 15 menit
      max: 100, // max 100 request / 15 menit
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
}

// === MIDDLEWARE ===
app.use(logger("dev"));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" })); // Naikkan limit untuk payload JSON jika perlu
app.use(express.urlencoded({ extended: true }));

// Public routes that don't need CSRF protection (e.g., initial handshake)
app.use("/api/keys", keysRouter);
app.use("/api/sessions", sessionsRouter);

// === CSRF Protection ===
// FIX: Gunakan sameSite: 'none' agar cookie bisa dikirim lintas domain (Vercel -> Render)
// Cookie secure wajib true jika sameSite='none'
const csrfProtection = csrf({
  cookie: { 
    httpOnly: true, 
    sameSite: "lax", 
    secure: isProd 
  }
});
app.use(csrfProtection);

// === ROUTE FOR CSRF TOKEN ===
app.get("/api/csrf-token", (req: Request, res: Response) => {
  res.json({ csrfToken: req.csrfToken() });
});

// === STATIC FILES (UPLOAD) ===
const uploadsPath = path.resolve(process.cwd(), env.uploadDir);
app.use("/uploads", 
  corsMiddleware, 
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  },
  express.static(uploadsPath, {
    index: false, 
    setHeaders: (res, filePath) => {
      const mimeType = express.static.mime.lookup(filePath);
      if (mimeType && !mimeType.startsWith('image/') && !mimeType.startsWith('video/') && !mimeType.startsWith('audio/')) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    }
  })
);

// === ROUTES ===
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/conversations", conversationsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/previews", previewsRouter);
app.use("/api/session-keys", sessionKeysRouter);
app.use("/api/sessions", sessionsRouter);

// === HEALTH CHECK ===
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// === ERROR HANDLING ===
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  if (err?.status && err?.message) {
    return res.status(err.status).json({ error: err.message });
  }

  console.error("❌ Server Error:", err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;