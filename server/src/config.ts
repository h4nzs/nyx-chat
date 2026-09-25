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
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  chatSecret: process.env.CHAT_SECRET || '',
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
