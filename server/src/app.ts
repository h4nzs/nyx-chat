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
import webpush from "web-push";
import { generalLimiter } from "./middleware/rateLimiter.js"; // Import ini
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

// PERBAIKAN: Set trust proxy ke true/angka tinggi.
// Karena via Vercel Rewrites, request melewati banyak hop (Vercel -> Render LB -> Nginx -> App).
// Jika diset 1, Express mungkin mengira request dari Vercel adalah client asli (HTTP), padahal aslinya HTTPS.
app.set('trust proxy', true);

// === SECURITY / CORS ===
const isProd = env.nodeEnv === 'production';

// Ambil origin untuk WebSocket secara dinamis
let wsOrigin = 'ws://localhost:4000';
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
        isProd ? "'strict-dynamic'" : "'unsafe-eval'",
        isProd ? "" : "https://*.ngrok-free.app",
        "https://challenges.cloudflare.com"
      ].filter(Boolean),
      styleSrc: [
        "'self'",
        "'unsafe-inline'", // Diperlukan untuk Tailwind CSS
      ],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://*.vercel.app",
        "https://*.koyeb.app",
        "https://*.upstash.io",
        "https://*.supabase.co"
      ],
      connectSrc: [
        "'self'",
        wsOrigin,
        "https://*.vercel.app",
        "wss://*.vercel.app",
        "https://*.koyeb.app",
        "wss://*.koyeb.app",
        "https://*.upstash.io", // Untuk Redis
        "https://*.supabase.co" // Untuk Supabase
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com" // Jika menggunakan Google Fonts
      ],
      objectSrc: ["'none'"],
      frameSrc: ["'self'", "https://challenges.cloudflare.com"],
      frameAncestors: ["'none'"],
      ...(isProd && { upgradeInsecureRequests: [] }),
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.disable('x-powered-by');

// Fungsi untuk memvalidasi origins yang diizinkan
const isAllowedOrigin = (origin: string): boolean => {
  if (!origin) return true; // Untuk request tanpa origin (misalnya dari curl)

  // Daftar origins yang diizinkan
  const allowedOrigins = [
    env.corsOrigin,
    "http://localhost:5173",
    "http://localhost:4173",
    // Domain Vercel
    "https://chat-lite-git-main-h4nzs.vercel.app",
    "https://chat-lite-h4nzs.vercel.app",
    "https://*.vercel.app",
    // Domain Koyeb
    "https://vast-aigneis-h4nzs-9319f44e.koyeb.app",
    "https://*.koyeb.app",
    // Domain Upstash
    "https://*.upstash.io",
    // Domain Supabase
    "https://*.supabase.co",
  ];

  // Cek apakah origin cocok dengan salah satu dari daftar yang diizinkan
  return allowedOrigins.some(allowedOrigin => {
    if (allowedOrigin.includes('*')) {
      // Jika ada wildcard, cocokkan dengan regex
      const regex = new RegExp('^' + allowedOrigin.replace(/\*/g, '.*') + '$');
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
  allowedHeaders: ["Content-Type", "Authorization", "CSRF-Token"],
});

app.use(corsMiddleware);

if (isProd) {
  app.use(
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
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Public routes that don't need CSRF protection
// === SECURITY & STABILITY ===

// 1. Rate Limiter Global (Pasang SEBELUM routes)
// Ini melindungi server dari DDoS sederhana / spam bot
app.use("/api", generalLimiter);

// 2. Request Timeout (Manual Implementation)
// Koyeb punya timeout sendiri, tapi Node.js sebaiknya memutus lebih cepat
// untuk membebaskan Event Loop.
app.use((req, res, next) => {
  res.setTimeout(30000, () => { // 30 Detik timeout untuk konsistensi
    res.status(408).send({ error: "Request Timeout" });
  });
  next();
});

// 3. Body Parser Limits (Sudah ada, tapi kita review)
// Batasi JSON body max 10MB (cukup buat base64 keys, tapi cegah payload bom)
app.use(express.json({ limit: "10mb" })); 
app.use(express.urlencoded({ extended: true, limit: "10mb" })); // Tambahkan limit juga disini
app.use("/api/keys", keysRouter);
app.use("/api/sessions", sessionsRouter);

// ... imports

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
});

// === CSRF Protection ===
// 'lax' cocok untuk arsitektur Proxy/Rewrite (First-Party simulation)
const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
  getSecret: () => env.jwtSecret,
  getSessionIdentifier: (req) => "api", // Stateless: relying on signed cookie matching header
  cookieName: "x-csrf-token",
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    path: "/",
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
app.use("/api/sessions", sessionsRouter);
app.use("/api/reports", reportRoutes);

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