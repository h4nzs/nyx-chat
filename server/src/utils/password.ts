import argon2, { HashOptions } from 'argon2'

// Konfigurasi buat VPS 4 core / 8GB RAM (sebelumnya "sweet spot" VPS 1GB RAM / 1 vCPU).
// Params TIDAK diubah saat upgrade — hash lama tetap tervalidasi karena argon2
// menyimpan params di dalam hash string-nya sendiri.
const ARGON_CONFIG: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 2 ** 15, // 32 MB (32 * 1024 kb)
  timeCost: 3, // Jumlah putaran hashing (3x cukup aman & cepat)
  parallelism: 1 // Sesuai jumlah vCPU lu
}

export const hashPassword = async (password: string): Promise<string> => {
  return await argon2.hash(password, ARGON_CONFIG)
}

export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, password)
  } catch (err) {
    console.error('Hash verification failed:', err)
    return false
  }
}
