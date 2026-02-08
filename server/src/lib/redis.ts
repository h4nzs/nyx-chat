import { createClient, type RedisClientType } from 'redis';
import { env } from '../config.js';

export const redisClient: RedisClientType = createClient({
  // FIX 1: Langsung pakai process.env untuk bypass error type di 'env'
  url: process.env.REDIS_URL,
  socket: {
    // FIX 2: Gunakan 'false' (boolean) bukan 0
    keepAlive: true,
    // Strategi Reconnect (Penting buat Upstash)
    reconnectStrategy: (retries) => {
      if (retries > 20) {
        console.error('❌ Redis Connection Retries Exhausted');
        return new Error('Redis connection retries exhausted');
      }
      return Math.min(retries * 100, 3000);
    },
    connectTimeout: 10000,
  }
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));
redisClient.on('connect', () => console.log('✅ Redis Client Connected'));

// Auto Connect
(async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect().catch((err) => {
      console.error('❌ Fatal: Failed to connect to Redis', err);
    });
  }
})();