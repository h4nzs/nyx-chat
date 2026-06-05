import { Router } from 'express';
import { redisClient } from '../lib/redis.js'; // Sesuaikan path redis Anda

const router = Router();

router.get('/status', async (req, res) => {
  try {
    // Ambil konfigurasi dari Redis (berupa string JSON)
    const statusData = await redisClient.get('nyx:system:status');
    
    // Default fallback jika belum di-set di Redis
    const defaultStatus = {
      maintenance: false,
      banner: {
        active: false,
        message: "",
        type: "info", // 'info' | 'warning' | 'error'
      }
    };

    const status = statusData ? JSON.parse(statusData) : defaultStatus;
    res.json(status);
  } catch (error) {
    // Jika Redis down, biarkan aplikasi tetap jalan (jangan block user)
    res.json({ maintenance: false, banner: { active: false } });
  }
});

export default router;
