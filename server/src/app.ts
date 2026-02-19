import express, { Express, Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import logger from "morgan";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { doubleCsrf } from "csrf-csrf";
import { env } from "./config.js";
import path from "path";
import crypto from "crypto";

import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import conversationsRouter from "./routes/conversations.js";
import messagesRouter from "./routes/messages.js";
import uploadsRouter from "./routes/uploads.js";
import keysRouter from "./routes/keys.js";
import previewsRouter from "./routes/previews.js";
import sessionKeysRouter from "./routes/sessionKeys.js";
import sessionsRouter from "./routes/sessions.js";
import aiRoutes from "./routes/ai.js";
import adminRouter from "./routes/admin.js";
import webpush from "web-push";
import { generalLimiter } from "./middleware/rateLimiter.js";
import { reportRoutes } from "./routes/reports.js";

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

// Trust Proxy: Wajib true karena di belakang Cloudflare & Nginx
app.set('trust proxy', true);

// === SECURITY / CORS ===
const isProd = env.nodeEnv === 'production';

// Ambil origin untuk WebSocket secara dinamis
let wsOrigin = 'ws://127.0.0.1:4000';
if (env.appUrl) {
  try {
    const url = new URL(env.appUrl);
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
      scriptSrc: [
        "'self'",
        "'unsafe-inline'", // Diperlukan karena index.html pakai inline script
        "'wasm-unsafe-eval'", // Diperlukan untuk modul crypto WASM
        "https://challenges.cloudflare.com",
        "https://static.cloudflareinsights.com",
        "https://cloudflareinsights.com",
        "https://*.cloudflare.com",
        isProd ? "" : "'unsafe-eval'" // Dev mode kadang butuh eval
      ].filter(Boolean),
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com"
      ],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://api.dicebear.com",
        "https://*.r2.dev",
        "https://cdn.jsdelivr.net",
        "https://*.cloudflarestorage.com",
        "https://nyx-app.my.id",
        "https://*.nyx-app.my.id"
      ],
      connectSrc: [
        "'self'",
        wsOrigin,
        "https://api.nyx-app.my.id",
        "wss://api.nyx-app.my.id",
        "https://nyx-app.my.id",
        "wss://nyx-app.my.id",
        "https://*.nyx-app.my.id",
        "https://*.cloudflareinsights.com",
        "https://cloudflareinsights.com",
        "https://*.r2.dev",
        "https://*.cloudflarestorage.com"
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com"
      ],
      objectSrc: ["'none'"],
      frameSrc: ["'self'", "https://challenges.cloudflare.com"],
      frameAncestors: ["'none'"],
      // Matikan upgradeInsecureRequests jika di local/http agar tidak force HTTPS
      ...(isProd ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  // Izinkan resource diload cross-origin (misal gambar avatar)
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.disable('x-powered-by');

// Helper to escape regex special characters
function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

// Fungsi untuk memvalidasi origins yang diizinkan
const isAllowedOrigin = (origin: string): boolean => {
  if (!origin) return true;

  const allowedOrigins = [
    env.corsOrigin,
    "http://localhost:5173",
    "http://localhost:4173",
    "https://*.supabase.co",
    // IZINKAN HTTP & HTTPS UNTUK CLOUDFLARE TUNNEL
    "https://nyx-app.my.id",
    "https://www.nyx-app.my.id",
    "https://*.nyx-app.my.id",
    "http://nyx-app.my.id",
    "http://www.nyx-app.my.id",
    "http://*.nyx-app.my.id",
  ];

  return allowedOrigins.some(allowedOrigin => {
    if (allowedOrigin.includes('*')) {
      // Securely escape the domain string first, then replace the escaped wildcard
      const escapedOrigin = escapeRegExp(allowedOrigin);
      const pattern = escapedOrigin.replace(/\\\*/g, '.*'); 
      const regex = new RegExp('^' + pattern + '$');
      return regex.test(origin);
    }
    return allowedOrigin === origin;
  });
};

const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      console.warn(`Blocked by CORS: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "CSRF-Token", "x-csrf-token"], // Tambahkan x-csrf-token
});

app.use(corsMiddleware);

// Global rate limiter for non-API routes (e.g. static assets, health checks if not under /api)
// This prevents conflict with the Redis-backed generalLimiter used for /api
if (isProd) {
  app.use(
    /^\/(?!api\/).*/, // Apply to everything EXCEPT paths starting with /api/
    rateLimit({
      windowMs: 15 * 60 * 1000, 
      max: 100, 
      standardHeaders: true,
      legacyHeaders: false,
      validate: { trustProxy: false }
    })
  );
}

// === MIDDLEWARE ===
app.use(logger("dev"));
app.use(cookieParser());
app.use(express.json({ limit: "15mb" })); // Naikkan limit upload sedikit
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// === SECURITY & STABILITY ===
app.use("/api", generalLimiter);

app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    res.status(408).send({ error: "Request Timeout" });
  });
  next();
});

// Routes publik (Keys & Sessions untuk E2EE)
app.use("/api/keys", keysRouter);

app.post("/api/admin/cleanup", async (req, res) => {
  const providedKey = req.headers["x-admin-key"];
  const secretKey = process.env.CHAT_SECRET;

  if (!providedKey || typeof providedKey !== 'string' || !secretKey) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const providedBuffer = Buffer.from(providedKey);
  const secretBuffer = Buffer.from(secretKey);

  if (providedBuffer.length !== secretBuffer.length || !crypto.timingSafeEqual(providedBuffer, secretBuffer)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  // TODO: Add actual cleanup logic here
  res.json({ message: "Cleanup triggered" });
});

// === CSRF Protection ===
const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
  getSecret: () => env.jwtSecret,
  getSessionIdentifier: (req) => "api",
  cookieName: "x-csrf-token",
  cookieOptions: {
    httpOnly: true,
    // PENTING: Gunakan 'none' agar cookie dikirim cross-site/subdomain
    sameSite: "none", 
    secure: true, // Wajib true jika sameSite=none
    path: "/",
    // Domain cookie agar bisa dibaca oleh frontend dan backend
    domain: isProd ? ".nyx-app.my.id" : undefined, 
  },
  size: 64,
  ignoredMethods: ["GET", "HEAD", "OPTIONS"],
  getCsrfTokenFromRequest: (req) => req.headers["csrf-token"] as string,
});

app.use(doubleCsrfProtection);

app.get("/api/csrf-token", (req: Request, res: Response) => {
  const csrfToken = generateCsrfToken(req, res);
  res.json({ csrfToken });
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

// === DISABLE CACHING FOR API ===
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
});

// === ROUTES ===
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/conversations", conversationsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/previews", previewsRouter);
app.use("/api/session-keys", sessionKeysRouter);
app.use("/api/reports", reportRoutes);
app.use("/api/admin", adminRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/ai", aiRoutes);

// === HEALTH CHECK ===
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok bang" });
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