// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import express, { Express, Request, Response, NextFunction } from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import logger from "morgan";
import cors from "cors";
import helmet from "helmet";
import mime from "mime";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
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
import adminRouter from "./routes/admin.js";
import engineRouter from "./routes/engine.js";
import storiesRoutes from "./routes/stories.js";
import subscriptionsRouter from "./routes/subscriptions.js";
import webpush from "web-push";
import { generalLimiter } from "./middleware/rateLimiter.js";
import { cfAwareClientIp } from "./utils/clientIp.js";
import { reportRoutes } from "./routes/reports.js";
import systemRouter from "./routes/system.js";
import wellKnownRouter from "./routes/wellKnown.js";

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

app.use(compression());

// Trust Proxy: tepat 2 hop — nginx (socket) + Cloudflare edge.
// JANGAN `true`: XFF di-append di tiap hop sehingga entri paling kiri bisa
// dipalsukan klien untuk bypass semua rate limit berbasis IP (temuan H1).
// Dengan jumlah hop eksak, entri XFF palsu di kiri diabaikan Express.
app.set('trust proxy', 2);

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
        "https://cdn.jsdelivr.net",
        "https://*.cloudflarestorage.com",
        "https://nyx-app.my.id",
	"https://api.nyx-app.my.id",
	"https://storage.nyx-app.my.id",
        "https://app.nyx-app.my.id"
      ],
      mediaSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://*.cloudflarestorage.com",
        "https://nyx-app.my.id",
        "https://api.nyx-app.my.id",
        "https://storage.nyx-app.my.id",
        "https://app.nyx-app.my.id"
      ],
      workerSrc: [
        "'self'",
        "blob:"
      ],
      connectSrc: [
        "'self'",
        wsOrigin,
        "https://api.nyx-app.my.id",
        "wss://api.nyx-app.my.id",
        "https://nyx-app.my.id",
	"https://app.nyx-app.my.id",
	"https://rt.nyx-app.my.id",
        "https://*.cloudflareinsights.com",
        "https://cloudflareinsights.com",
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

app.use((req, res, next) => {
  res.setHeader('X-Edge-Relay', 'nyx-enigma');
  res.setHeader('X-Sec-Protocol', 'Double-Ratchet-Core');
  res.setHeader('X-Powered-By', 'NYX-Engine');
  next();
});

// Helper to escape regex special characters
function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

// Fungsi untuk memvalidasi origins yang diizinkan
const isAllowedOrigin = (origin: string): boolean => {
  if (!origin) return true;

  // 👇 PERBAIKAN: Ratakan array jika env.corsOrigin berbentuk array
  const baseOrigins = Array.isArray(env.corsOrigin) ? env.corsOrigin : [env.corsOrigin];

  const allowedOrigins = [
    ...baseOrigins, // 👈 PERBAIKAN: Gunakan spread operator (...)
    // IZINKAN HTTP & HTTPS UNTUK CLOUDFLARE TUNNEL
    "https://nyx-app.my.id",
    "https://www.nyx-app.my.id",
    "https://api.nyx-app.my.id",
    "https://app.nyx-app.my.id",
    "https://rt.nyx-app.my.id",
    "https://storage.nyx-app.my.id",
    // Varian HTTP & localhost HANYA untuk development (mencegah mixed-content
    // origin diterima di production)
    ...(!isProd ? [
      "http://localhost:5173",
      "http://localhost:4173",
      "http://nyx-app.my.id",
      "http://www.nyx-app.my.id",
      "http://app.nyx-app.my.id",
      "http://api.nyx-app.my.id",
      "http://rt.nyx-app.my.id",
      "http://storage.nyx-app.my.id",
    ] : []),
  ];

  return allowedOrigins.some(allowedOrigin => {
    if (allowedOrigin.includes('*')) {
      const escapedOrigin = escapeRegExp(allowedOrigin);
      const pattern = escapedOrigin.replace(/\\\*/g, '.*'); 
      const regex = new RegExp('^' + pattern + '$');
      return regex.test(origin);
    }
    return allowedOrigin === origin;
  });
};

const corsMiddleware = cors({
  origin: (originHeader, callback) => {
    const origin = originHeader || '';
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      console.warn(`Blocked by CORS: ${origin}`);
      // Deny WITHOUT throwing: an Error here would fall through to the generic
      // error handler (500). callback(null, false) omits ACAO headers so the
      // browser blocks the response instead.
      callback(null, false);
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type", 
    "Authorization", 
    "CSRF-Token", 
    "x-csrf-token",
    "x-nyx-fingerprint",
    "x-nyx-installation-id",
    "x-group-token"
  ],
});

app.use(corsMiddleware);

// Global rate limiter for non-API routes (e.g. static assets, health checks if not under /api)
// This prevents conflict with the Redis-backed generalLimiter used for /api
if (isProd) {
  app.use(
    /^\/(?!api\/).*/, // Apply to everything EXCEPT paths starting with /api/
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 1000, // Capped at 1000 to prevent resource exhaustion via CF Tunnel bypass.
      standardHeaders: true,
      legacyHeaders: false,
      validate: { trustProxy: false },
      // Keying tahan-palsu sama seperti limiter /api (CF-Connecting-IP dulu).
      keyGenerator: (req) => ipKeyGenerator(cfAwareClientIp(req))
    })
  );
}

// === MIDDLEWARE ===
// Morgan hanya di development — di prod `dev` mencatat URL penuh termasuk query
// param sensitif (mis. identifier pada recover challenge).
if (!isProd) {
  app.use(logger("dev"));
}
app.use(cookieParser());

// Body Parser Split: Uploads butuh limit besar, lainnya kecil (Security)
app.use("/api/uploads", express.json({ limit: "1mb" }));
app.use("/api/uploads", express.urlencoded({ extended: true, limit: "1mb" }));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// === SECURITY & STABILITY ===
app.use("/api", generalLimiter);

app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    res.status(408).send({ error: "Request Timeout" });
  });
  next();
});

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
  getSecret: () => env.csrfSecret,
  // PERBAIKAN: identifier per-KLIEN (bukan "api" global) — sebelumnya semua
  // klien berbagi satu state CSRF sehingga dua tab/klien bisa saling menimpa
  // token (menyebabkan 403 acak saat multi-tab / paralel).
  getSessionIdentifier: (req) => {
    const iid = req.headers['x-nyx-installation-id'];
    if (typeof iid === 'string' && iid.length > 0) return `iid:${iid}`;
    // cfAwareClientIp: XFF bisa dipalsukan di jalur tunnel langsung ke Express;
    // CF-Connecting-IP ditimpa edge Cloudflare sehingga tidak bisa dipalsukan.
    return `ip:${cfAwareClientIp(req)}`;
  },
  cookieName: "x-csrf-token",
  cookieOptions: {
    httpOnly: true,
    sameSite: "none", 
    secure: true, 
    path: "/",
    domain: isProd ? ".nyx-app.my.id" : undefined, 
  },
  size: 64,
  ignoredMethods: ["GET", "HEAD", "OPTIONS"],
  getCsrfTokenFromRequest: (req) => String(req.headers['csrf-token'] ?? ''),
});

app.use((req, res, next) => {
  // [PAYMENTS CRYPTO-ONLY] Exempt Tripay webhook dihapus — hanya NOWPayments.
  if (req.path === '/api/subscriptions/nowpayments-webhook' || req.path.startsWith('/api/engine')) {
    return next();
  }
  doubleCsrfProtection(req, res, next);
});

// Keys router HARUS di-mount di bawah doubleCsrfProtection. Sebelumnya
// diletakkan sebelum layer CSRF → mutasi pre-key bisa di-CSRF lintas situs
// (cookie SameSite=None + form urlencoded tanpa preflight).
app.use("/api/keys", keysRouter);

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
    maxAge: '1y', // Cache agresif (1 tahun)
    immutable: true, // Beritahu browser bahwa file tidak akan pernah berubah
    setHeaders: (res, filePath) => {
      const mimeType = mime.getType(filePath);
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
app.use("/api/engine", engineRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/stories", storiesRoutes);
app.use("/api/system", systemRouter);
app.use("/.well-known", wellKnownRouter);

// === HEALTH CHECK ===
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok bang" });
});

// === GENERIC ERROR HANDLING ===
app.use((err: Error & { type?: string, status?: number, code?: string }, _req: Request, res: Response, _next: NextFunction) => {
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
