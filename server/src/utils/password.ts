import argon2 from "argon2";
import bcrypt from "bcrypt";

// Konfigurasi "Sweet Spot" buat VPS 1GB RAM / 1 vCPU
const ARGON_CONFIG = {
  type: argon2.argon2id,
  memoryCost: 2 ** 15, // 32 MB (32 * 1024 kb)
  timeCost: 3,         // Jumlah putaran hashing (3x cukup aman & cepat)
  parallelism: 1,      // Sesuai jumlah vCPU lu
};

export const hashPassword = async (password: string): Promise<string> => {
  return await argon2.hash(password, ARGON_CONFIG);
};

export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  // 1. Cek apakah ini hash Bcrypt (User lama)
  // Bcrypt hash biasanya diawali $2b$, $2a$, atau $2y$
  if (hash.startsWith("$2")) {
    return await bcrypt.compare(password, hash);
  }

  // 2. Kalau bukan, anggap Argon2
  try {
    return await argon2.verify(hash, password);
  } catch (err) {
    console.error("Hash verification failed:", err);
    return false;
  }
};

export const needsRehash = (hash: string): boolean => {
  // Kalau hash-nya masih format Bcrypt, berarti perlu di-update ke Argon2
  return hash.startsWith("$2");
};
