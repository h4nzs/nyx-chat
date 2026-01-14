import { createClient, type RedisClientType } from 'redis';

export const redisClient: RedisClientType = createClient({
  // Konfigurasi default akan menggunakan redis://127.0.0.1:6379
  // Tambahkan URL di sini jika Redis Anda berjalan di tempat lain
  url: process.env.REDIS_URL
});

redisClient.on('error', err => console.error('❌ Redis Client Error', err));

// Mulai koneksi di latar belakang
redisClient.connect().catch(console.error);
