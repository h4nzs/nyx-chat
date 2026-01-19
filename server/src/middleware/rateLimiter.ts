import rateLimit from "express-rate-limit";
import { env } from "../config.js";

// Helper biar gak spam log saat development
const skipInDev = () => env.nodeEnv === 'development';

// 1. General Limiter: Untuk semua route API umum
// Batas: 300 request per 15 menit per IP
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 300, 
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: skipInDev,
  message: {
    error: "Too many requests, please try again later."
  }
});

// 2. Auth Limiter: Sangat Ketat untuk Login/Register/Restore
// Batas: 10 request per jam per IP
// Ini akan bikin bot nangis darah kalau mau nebak password
export const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 jam
  max: 10, 
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInDev,
  message: {
    error: "Too many login attempts. Please try again after an hour."
  }
});

// 3. Upload Limiter: Mencegah spam upload file
// Batas: 10 upload per jam
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, 
  max: 20,
  message: {
    error: "Upload limit reached. Please wait a while."
  }
});