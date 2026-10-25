import 'dotenv/config'
import { readFileSync } from 'fs';
import { URL } from 'url';

// Validate required environment variables
const requiredEnvVars = ['PORT', 'CORS_ORIGIN', 'JWT_SECRET'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
const packageJsonPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };

if (missingEnvVars.length > 0) {
  console.warn(`⚠️  Missing required environment variables: ${missingEnvVars.join(', ')}`);
}

// Validate JWT secret in production
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret')) {
  throw new Error('JWT_SECRET must be set to a secure value in production environment');
}

// Warn if CSRF_SECRET is not explicitly set (recommended for defense in depth)
const csrfSecretRaw = (process.env.CSRF_SECRET || '').trim();
if (!csrfSecretRaw && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  CSRF_SECRET not set (or empty). Falling back to JWT_SECRET for CSRF protection. For better security isolation, set CSRF_SECRET to an independent random value in your PRODUCTION .env file (the one copied over server/.env on deploy).');
}

// [docs/31 §31.6 fase 3] Rahasia turunan kunci objek backup (HMAC). Bila tidak
// diset, jatuh ke JWT_SECRET — tetapi rotasi JWT_SECRET akan membuat backup
// awan lama tak bisa ditemukan lagi, jadi produksi sebaiknya menyetel nilai
// independen yang stabil.
const backupKeySecretRaw = (process.env.BACKUP_KEY_SECRET || '').trim();
if (!backupKeySecretRaw && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  BACKUP_KEY_SECRET not set. Falling back to JWT_SECRET for backup object keys; rotating JWT_SECRET will orphan existing cloud backups. Set BACKUP_KEY_SECRET to an independent stable random value in your PRODUCTION .env file.');
}

/**
 * [OPS 2026-10-25] Domain untuk cookie sesi (`at`/`rt`) dan cookie CSRF.
 *
 * Deployment resmi memecah origin: REST dilayani di `app.nyx-app.my.id`
 * (relatif `/api`), sedangkan relay realtime dilayani di `api.nyx-app.my.id`.
 * Cookie tanpa `Domain` bersifat **host-only**: browser hanya mengirimkannya
 * kembali ke host yang menerbitkannya. Akibatnya handshake socket.io ke
 * `api.nyx-app.my.id` tidak membawa `at`, gateway menolak (`unauthorized`),
 * dan klien berhenti di `ESTABLISHING_UPLINK` selamanya — insiden 2026-10-25.
 *
 * Kosong = perilaku lama (host-only). Deployment satu-domain (self-host)
 * memang tidak perlu menyetel nilai ini.
 */
function normalizeCookieDomain(raw: string | undefined): string | undefined {
  const value = (raw || '').trim();
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value) || value.includes('/')) {
    console.warn('⚠️  COOKIE_DOMAIN harus berupa domain (mis. `.nyx-app.my.id`), bukan URL — diabaikan.');
    return undefined;
  }
  // `Domain=.localhost` ditolak browser; titik hanya ditambahkan pada nama
  // domain bertitik (subdomain) supaya bentuk baku `.example.tld` tetap dipakai.
  if (value.includes('.') && !value.startsWith('.')) return `.${value}`;
  return value;
}

export const env = {
  port: parseInt(process.env.PORT || '4000', 10),
  corsOrigin: (process.env.CORS_ORIGIN || 'https://app.nyx-app.my.id')
  .split(',')
  .map(url => url.trim()),

  // --- DITAMBAHKAN AGAR BUILD BERHASIL ---
  appUrl: process.env.APP_URL || 'https://api.nyx-app.my.id',
  // ---------------------------------------

  jwtSecret: process.env.JWT_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is required in production environment')
    }
    return 'dev-secret'
  })(),
  csrfSecret: csrfSecretRaw || process.env.JWT_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CSRF_SECRET is required in production environment')
    }
    return 'dev-csrf-secret'
  })(),
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  nodeEnv: process.env.NODE_ENV || 'development',
  cookieDomain: normalizeCookieDomain(process.env.COOKIE_DOMAIN),
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  chatSecret: process.env.CHAT_SECRET || '',
  backupKeySecret: backupKeySecretRaw || process.env.JWT_SECRET || 'dev-backup-secret',
  r2AccountId: process.env.R2_ACCOUNT_ID || "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  r2BucketName: process.env.R2_BUCKET_NAME || "",
  r2PublicDomain: process.env.R2_PUBLIC_DOMAIN || "",
  discordReportWebhookUrl: process.env.DISCORD_REPORT_WEBHOOK_URL,
  appVersion: pkg.version,

  cfAccountId: process.env.CF_ACCOUNT_ID || '',
  cfTurnKeyId: process.env.CF_TURN_KEY_ID || '',
  cfTurnApiToken: process.env.CF_TURN_API_TOKEN || '',
}
