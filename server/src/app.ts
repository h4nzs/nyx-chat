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
import { rateLimit } from "express-rate-limit";
import { doubleCsrf } from "csrf-csrf";
import { env } from "./config.js";
import path from "path";
import crypto from "crypto";
import { prisma } from "./lib/prisma.js";
import { purgeSealedUserRows } from "./utils/routingIdentity.js";
import { authorizeAdminCleanup } from "./utils/adminCleanupAuth.js";
import { runCleanup } from "./jobs/cleanup.js";
import { ADMIN_CLEANUP, incCounter } from "./utils/metrics.js";

import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import conversationsRouter from "./routes/conversations.js";
import messagesRouter from "./routes/messages.js";
import uploadsRouter from "./routes/uploads.js";
import backupRouter from "./routes/backup.js";
import keysRouter from "./routes/keys.js";
import ktQueryRouter from "./routes/ktQuery.js";
import previewsRouter from "./routes/previews.js";
import sessionKeysRouter from "./routes/sessionKeys.js";
import burnerRouter from "./routes/burner.js";
import sessionsRouter from "./routes/sessions.js";
// [docs/30 §30.9 WS-E(2)] Penerbit alamat relay panggilan (token, bukan userId).
import callTokensRouter from "./routes/callTokens.js";
// [docs/35 Fase 3] OHTTP — router hanya dipasang bila OHTTP_ENABLED=1.
import createOhttpRouter from "./routes/ohttp.js";
import { loadOhttpConfig } from "./ohttp/config.js";
import adminRouter from "./routes/admin.js";
import engineRouter from "./routes/engine.js";
import storiesRoutes from "./routes/stories.js";
import subscriptionsRouter from "./routes/subscriptions.js";
import webpush from "web-push";
import { adminCleanupLimiter, generalLimiter } from "./middleware/rateLimiter.js";
import { clientVersionGate } from "./middleware/clientVersion.js";
import { cfAwareClientIp, clientIpTag } from "./utils/clientIp.js";
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
    // [SELF-HOST FIX 2026-10-15] Klien web mengirim header versi build ini di
    // SETIAP request REST (`web/src/lib/clientVersion.ts`, dikonsumsi
    // `middleware/clientVersion.ts`). Karena app dan API beda origin
    // (app.nyx-app.my.id → api.nyx-app.my.id), preflight OPTIONS memeriksa
    // daftar ini: tanpa whitelist, browser memblokir SEMUA panggilan API dengan
    // "Request header field x-nyx-client-version is not allowed by
    // Access-Control-Allow-Headers" — halaman jadi kosong tanpa pesan jelas.
    "x-nyx-client-version",
    "x-group-token",
    // [BUGFIX CORS 2026-10-02] Header capability/ blind-auth WAJIB di-whitelist
    // — tanpa ini preflight OPTIONS gagal dan SEMUA request ber-header ini
    // diblokir browser (terlihat di log: add-participant → key-rotation & PUT
    // details NetworkError → metadata era baru tak pernah sampai ke server →
    // anggota baru gagal decrypt metadata & gagal kirim).
    "x-admin-token",
    "x-delivery-tokens",
    "x-delete-token"
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
      // Keying tahan-palsu sama seperti limiter /api (CF-Connecting-IP dulu),
      // dan sama-sama **tag HMAC** — bukan alamat klien (docs/30 §30.12 WS-H).
      keyGenerator: (req) => clientIpTag(req)
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

// [R2 2026-10-15] Gerbang versi klien. Dipasang SEBELUM CSRF dan sebelum router
// mana pun: klien yang terlalu tua ditolak lebih awal (HTTP 426 +
// `CLIENT_TOO_OLD`), jadi ia mendapat pesan "perbarui" yang jelas alih-alih
// perilaku setengah jalan (mis. kehilangan kunci grup tanpa error). Gerbang mati
// bila `MIN_CLIENT_VERSION` tidak diset, dan klien yang tidak mengirim header
// versi tetap lolos — lihat `utils/clientVersion.ts` untuk alasan lengkapnya.
app.use("/api", clientVersionGate(() => ({ minimumVersion: process.env.MIN_CLIENT_VERSION })));

app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    res.status(408).send({ error: "Request Timeout" });
  });
  next();
});

/**
 * Pemeliharaan manual untuk operator (docs/10 §10.13): jalankan **putaran
 * pembersihan yang sama** dengan cron `systemSweeper` tanpa menunggu jam 00:00.
 *
 * Dulu endpoint ini hanya memvalidasi kunci lalu menjawab "Cleanup triggered"
 * tanpa melakukan apa pun — jawaban sukses untuk pekerjaan yang tidak terjadi.
 * Sekarang ia memanggil `runCleanup` (satu implementasi dengan cron) dan
 * mengembalikan hitungan per jenis baris + kegagalan per langkah, jadi operator
 * bisa membuktikan pekerjaannya benar dari respons, bukan dari asumsi.
 *
 * Otorisasi: `x-admin-key` (perbandingan timing-safe, fail-closed bila rahasia
 * server kosong). [R6 2026-10-15] Kebijakannya dipindah ke fungsi murni
 * `utils/adminCleanupAuth.ts` supaya bisa diuji, dan dikeraskan karena endpoint
 * ini destruktif: rahasia TERPISAH (`ADMIN_CLEANUP_SECRET`, fallback
 * `CHAT_SECRET` untuk kompatibilitas), allow-list IP OPSIONAL
 * (`ADMIN_CLEANUP_IP_ALLOWLIST`), rate limit khusus (`adminCleanupLimiter`,
 * 5/jam), plus metrik + log audit. Endpoint tetap berada sebelum middleware CSRF
 * agar bisa dipanggil dari cron/ops memakai kunci, bukan sesi browser.
 */
app.post("/api/admin/cleanup", adminCleanupLimiter, async (req, res) => {
  const decision = authorizeAdminCleanup(
    { providedKey: req.headers["x-admin-key"], clientIp: cfAwareClientIp(req) },
    {
      cleanupSecret: process.env.ADMIN_CLEANUP_SECRET,
      chatSecret: process.env.CHAT_SECRET,
      ipAllowlist: process.env.ADMIN_CLEANUP_IP_ALLOWLIST,
    }
  );

  if (!decision.ok) {
    // Dua kelas berbeda supaya operator bisa membedakan "salah kunci" dari
    // "konfigurasi belum lengkap" — tanpa mencatat IP atau nilai kunci ke metrik.
    const result = decision.reason === 'secret-not-configured' ? 'error' : 'forbidden';
    incCounter(ADMIN_CLEANUP, { result });
    console.warn(`[Admin] cleanup ditolak (${decision.reason})`);
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const report = await runCleanup(prisma, {
      purgeUser: (userId) => purgeSealedUserRows(prisma, userId),
      log: (message) => console.log(message),
    });
    // Kegagalan sebagian dijawab non-2xx: operator harus melihat bahwa ada
    // langkah yang belum bersih, bukan banner "berhasil" di atas pekerjaan separuh.
    const status = report.errors.length > 0 ? 500 : 200;
    incCounter(ADMIN_CLEANUP, { result: report.errors.length > 0 ? 'partial' : 'ok' });
    console.log(
      `[Admin] cleanup manual selesai (rahasia ${decision.dedicatedSecret ? 'khusus' : 'CHAT_SECRET'}): ` +
      `refreshTokens=${report.refreshTokens} sessionKeys=${report.sessionKeys} accounts=${report.accounts} ` +
      `subscriptions=${report.subscriptions} stories=${report.stories} errors=${report.errors.length}`
    );
    res.status(status).json({
      message: report.errors.length > 0 ? "Cleanup selesai dengan kegagalan sebagian" : "Cleanup selesai",
      counts: {
        refreshTokens: report.refreshTokens,
        sessionKeys: report.sessionKeys,
        accounts: report.accounts,
        subscriptions: report.subscriptions,
        stories: report.stories,
      },
      errors: report.errors,
    });
  } catch (error) {
    incCounter(ADMIN_CLEANUP, { result: 'error' });
    console.error("[Admin] Cleanup gagal:", error);
    res.status(500).json({ error: "Cleanup failed" });
  }
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

// [docs/35 Fase 3] OHTTP di-mount SEBELUM lapisan CSRF: amplopnya opaque dan
// tidak membawa cookie/header yang bisa diverifikasi di sini. Header target
// (termasuk token CSRF) ikut DI DALAM request terenkripsi dan diverifikasi
// ulang oleh API setelah gateway melakukan dispatch. Tanpa OHTTP_ENABLED=1,
// router tidak dipasang sama sekali (jalur 404, bukan 403).
const ohttpConfig = loadOhttpConfig();
if (ohttpConfig) {
  app.use("/api/ohttp", createOhttpRouter(ohttpConfig));
}

app.use((req, res, next) => {
  // [PAYMENTS CRYPTO-ONLY] Exempt Tripay webhook dihapus — hanya NOWPayments.
  if (req.path === '/api/subscriptions/nowpayments-webhook' || req.path.startsWith('/api/engine')) {
    return next();
  }
  doubleCsrfProtection(req, res, next);
});

// [docs/30 §30.5 WS-A] Proxy bukti Key Transparency. Di-mount SEBELUM router
// keys yang lebih umum supaya `/api/keys/kt/*` tidak jatuh ke `/:something`.
app.use("/api/keys/kt", ktQueryRouter);

// Keys router HARUS di-mount di bawah doubleCsrfProtection. Sebelumnya
// diletakkan sebelum layer CSRF → mutasi pre-key bisa di-CSRF lintas situs
// (cookie SameSite=None + form urlencoded tanpa preflight).
app.use("/api/keys", keysRouter);
app.use("/api/call-tokens", callTokensRouter);

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
app.use("/api/backup", backupRouter);
app.use("/api/previews", previewsRouter);
app.use("/api/session-keys", sessionKeysRouter);
// [BURNER 2026-10-18] Status room burner — gerbang destroy yang tidak bergantung
// pada socket (guest offline / reload / membership basi).
app.use("/api/burner", burnerRouter);
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
