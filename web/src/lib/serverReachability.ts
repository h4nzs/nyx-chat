import { ApiError } from './api';

/**
 * Apakah error ini berarti SERVER tidak terjangkau (bukan error aplikasi biasa)?
 *
 * Dipakai `systemStore.checkStatus` untuk memutuskan menampilkan ServerDownPage.
 * Sengaja sempit agar 401/403/404/429/500 (respons sah dari server yang hidup)
 * TIDAK pernah memicu layar "server down":
 *   - ApiError(0)        → timeout (lihat `api()` yang memetakan TimeoutError ke status 0)
 *   - 502 / 503 / 504    → gateway/nginx saat upstream mati, atau JSON 503 dari Worker Cloudflare
 *   - 520–530            → error origin Cloudflare (mis. 530/1033 saat tunnel mati)
 *   - TypeError          → fetch gagal di level jaringan (offline, DNS, koneksi ditolak)
 * Abort dari pemanggil (AbortError) bukan kegagalan server → false.
 */
export function isServerUnreachable(err: unknown): boolean {
  if (err instanceof ApiError) {
    const s = err.status;
    return s === 0 || s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530);
  }
  return err instanceof TypeError;
}
