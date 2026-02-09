import 'dotenv/config'

// Validate required environment variables
const requiredEnvVars = ['PORT', 'CORS_ORIGIN', 'JWT_SECRET'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.warn(`⚠️  Missing required environment variables: ${missingEnvVars.join(', ')}`);
}

// Validate JWT secret in production
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret')) {
  throw new Error('JWT_SECRET must be set to a secure value in production environment');
}

export const env = {
  port: parseInt(process.env.PORT || '4000', 10),
  corsOrigin: process.env.CORS_ORIGIN || 'https://nyx-app.my.id',
  
  // --- DITAMBAHKAN AGAR BUILD BERHASIL ---
  appUrl: process.env.APP_URL || 'https://api.nyx-app.my.id',
  // ---------------------------------------
  
  jwtSecret: process.env.JWT_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is required in production environment')
    }
    return 'dev-secret'
  })(),
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  nodeEnv: process.env.NODE_ENV || 'development',
  s3Bucket: process.env.S3_BUCKET || '',
  s3Region: process.env.S3_REGION || '',
  s3AccessKey: process.env.S3_ACCESS_KEY || '',
  s3SecretKey: process.env.S3_SECRET_KEY || '',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  chatSecret: process.env.CHAT_SECRET || '',
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || "",
  r2AccountId: process.env.R2_ACCOUNT_ID || "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  r2BucketName: process.env.R2_BUCKET_NAME || "",
  r2PublicDomain: process.env.R2_PUBLIC_DOMAIN || "",
  discordReportWebhookUrl: process.env.DISCORD_REPORT_WEBHOOK_URL,
}