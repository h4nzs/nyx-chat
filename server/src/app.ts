import express, { Request, Response, NextFunction } from "express";

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

// Set VAPID keys for web-push notifications (only if all required environment variables are set)
if (process.env.VAPID_SUBJECT && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn("⚠️ VAPID keys not configured. Push notifications will be disabled.");
  console.warn("To enable push notifications, set VAPID_SUBJECT, VAPID_PUBLIC_KEY, and VAPID_PRIVATE_KEY environment variables.");
}

const app = express();

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
      // 'unsafe-eval' diperlukan untuk hot-reloading di mode development
      scriptSrc: ["'self'", isProd ? '' : "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Diperlukan untuk styling dinamis
      imgSrc: ["'self'", "data:", "blob:"], // blob: diperlukan untuk avatar preview
      connectSrc: ["'self'", wsOrigin],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"], // Mencegah clickjacking
      ...(isProd && { upgradeInsecureRequests: [] }),
    },
  },
}));
// Hapus header X-Powered-By untuk menyembunyikan detail teknologi server
app.disable('x-powered-by');

const corsMiddleware = cors({
  origin: env.corsOrigin || "http://localhost:5173",
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

// Public routes that don't need CSRF protection
app.use("/api/keys", keysRouter);
app.use("/api/sessions", sessionsRouter);

// === CSRF Protection ===
const csrfProtection = csrf({
  cookie: { httpOnly: true, sameSite: "strict", secure: env.nodeEnv === "production" }
});
app.use(csrfProtection);

// === ROUTE FOR CSRF TOKEN ===
app.get("/api/csrf-token", (req: Request, res: Response) => {
  res.json({ csrfToken: req.csrfToken() });
});

// === STATIC FILES (UPLOAD) - SECURE IMPLEMENTATION ===
const uploadsPath = path.resolve(process.cwd(), env.uploadDir);
app.use("/uploads", 
  corsMiddleware, // Apply the CORS middleware here as well
  // Middleware untuk menambahkan header CORP & keamanan lainnya
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  },
  express.static(uploadsPath, {
    // Nonaktifkan directory listing
    index: false, 
    // Jangan jalankan file secara otomatis, paksa download untuk tipe tertentu jika perlu
    setHeaders: (res, filePath) => {
      const mimeType = express.static.mime.lookup(filePath);
      if (mimeType && !mimeType.startsWith('image/') && !mimeType.startsWith('video/') && !mimeType.startsWith('audio/')) {
        // Paksa download untuk dokumen dan file lainnya
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