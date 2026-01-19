import { createClient, type RedisClientType } from 'redis';
import { env } from '../config.js'; // Pastikan import env dari config project lu

// Gunakan URL dari env config, atau fallback ke process.env
const redisUrl = env.redisUrl || process.env.REDIS_URL;

export const redisClient: RedisClientType = createClient({
  url: redisUrl,
  socket: {
    // PENTING UNTUK UPSTASH:
    // Matikan keepAlive agar koneksi idle tidak menyebabkan error saat serverless Redis tidur
    keepAlive: 0, 
    // Strategi Reconnect Otomatis jika koneksi diputus Upstash
    reconnectStrategy: (retries) => {
      // Maksimal coba 20 kali
      if (retries > 20) {
        console.error('❌ Redis Connection Retries Exhausted');
        return new Error('Redis connection retries exhausted');
      }
      // Tunggu bertahap: 100ms, 200ms... sampai maksimal 3 detik
      return Math.min(retries * 100, 3000);
    },
    // Timeout koneksi (10 detik)
    connectTimeout: 10000,
  }
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));
redisClient.on('connect', () => console.log('✅ Redis Client Connected'));
redisClient.on('reconnecting', () => console.log('🔄 Redis Reconnecting...'));

// Inisialisasi koneksi
(async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect().catch((err) => {
      console.error('❌ Fatal: Failed to connect to Redis on startup', err);
    });
  }
})();