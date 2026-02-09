import { createClient, type RedisClientType } from 'redis';
import { env } from '../config.js';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const redisClient: RedisClientType = createClient({
  url: redisUrl,
  socket: {
    keepAlive: true,
    // Strategi Reconnect untuk VPS/Local (Cepat pulih jika service restart)
    reconnectStrategy: (retries) => {
      if (retries > 50) {
        console.error('❌ Redis Connection Retries Exhausted');
        return new Error('Redis connection retries exhausted');
      }
      // Retry setiap 500ms, max 2 detik
      return Math.min(retries * 50, 2000);
    },
    connectTimeout: 5000,
  }
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));
redisClient.on('connect', () => {
  // Masking URL untuk keamanan log, tapi cukup untuk verifikasi host
  const maskedUrl = redisUrl.replace(/(:[^:@]+@)/, ':****@'); 
  console.log(`✅ Redis Client Connected to ${maskedUrl}`);
});

// Auto Connect
(async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect().catch((err) => {
      console.error('❌ Fatal: Failed to connect to Redis', err);
    });
  }
})();