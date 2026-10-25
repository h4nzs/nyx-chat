// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import toast from 'react-hot-toast'; // Pastikan sudah diinstall
import { CLIENT_VERSION_HEADER, CLIENT_VERSION_VALUE } from './clientVersion';

// PERBAIKAN: Baca dari Environment Variable
const envUrl = import.meta.env.VITE_API_URL || "";

// Hapus '/api' di akhir URL jika user tidak sengaja memasukkannya di .env
// Hasilnya bersih: "https://api.domain.com"
const API_URL = envUrl.replace(/\/api\/?$/, "").replace(/\/$/, "");

export function getApiBaseUrl(): string {
  return API_URL;
}

// Cache untuk token CSRF
let csrfTokenCache: string | null = null;

// [CSRF RACE] `generateCsrfToken` server MENERBITKAN cookie baru setiap panggilan
// `GET /api/csrf-token`. Bila beberapa mutasi berjalan paralel saat cache masih
// dingin (mis. StrictMode double-invoke, atau boot + aksi user bersamaan),
// masing-masing memanggil endpoint itu dan cookie terakhir menimpa yang lain —
// sementara cache klien menyimpan token dari respons yang selesai lebih dulu →
// POST acak ditolak `403 Invalid CSRF token`.
// Single-flight: satu request in-flight dibagi ke semua pemanggil, jadi token di
// cache SELALU token dari cookie yang terakhir ditulis server.
let csrfTokenPromise: Promise<string> | null = null;

// [ROBUSTNESS] Timeout default request REST. Tanpa ini, request yang menggantung
// (server tak merespons, jaringan setengah mati) menunggu tanpa batas — UI
// nyangkut tanpa pesan error dan offline queue terasa mati.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000; // upload lampiran bisa besar → lebih longgar
const CSRF_TIMEOUT_MS = 10_000;

export interface ApiRequestOptions extends RequestInit {
  /** Override timeout per-call (ms). 0 → tanpa timeout (jalur streaming panjang). */
  timeoutMs?: number;
  /**
   * Jalur token-only (sync/mailbox grup): jangan kirim cookie, installation ID,
   * atau CSRF. Server tidak boleh bisa mengaitkan request ini ke akun.
   */
  anonymous?: boolean;
}

/**
 * Gabungkan AbortSignal eksternal pemanggil dengan timeout internal menjadi satu
 * sinyal. Dipakai manual (bukan AbortSignal.any) agar bekerja di semua browser
 * target dan bisa diuji dengan timeout kecil di unit test.
 */
function combineWithTimeout(
  timeoutMs: number,
  external: AbortSignal | null | undefined
): { signal: AbortSignal | undefined; cancel: () => void } {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(
      () => controller.abort(new DOMException(`Request timeout setelah ${timeoutMs}ms`, 'TimeoutError')),
      timeoutMs
    );
  }
  return {
    signal: controller.signal,
    cancel: () => {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

// Handler for auth failure (Logout)
let onAuthFailure: (() => Promise<void>) | null = null;

// Identifier per-klien untuk state CSRF server (mencegah dua klien saling menimpa token).
// WAJIB sama dengan installationId yang dikirim flow register/login (kvStore Dexie) —
// kalau beda, token CSRF di-generate & divalidasi dengan id berbeda → 403.
let clientInstallationIdPromise: Promise<string> | null = null;

export function getClientInstallationId(): Promise<string> {
  if (!clientInstallationIdPromise) {
    clientInstallationIdPromise = import('@utils/fingerprint')
      .then(m => m.getPersistentInstallationId())
      .catch(() => {
        let iid = sessionStorage.getItem('nyx_installation_id');
        if (!iid) {
          iid = crypto.randomUUID();
          sessionStorage.setItem('nyx_installation_id', iid);
        }
        return iid;
      });
  }
  return clientInstallationIdPromise;
}

export function setAuthFailureHandler(handler: () => Promise<void>) {
  onAuthFailure = handler;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Mengambil token CSRF. 
 * Note: Jika backend kamu stateless (JWT murni di header), ini mungkin tidak perlu.
 * Tapi jika pakai Cookie + CSRF protection, ini wajib.
 */
export async function getCsrfToken(): Promise<string> {
  if (csrfTokenCache) return csrfTokenCache;
  if (csrfTokenPromise) return csrfTokenPromise;

  csrfTokenPromise = (async () => {
    const { signal, cancel } = combineWithTimeout(CSRF_TIMEOUT_MS, null);

    try {
      const res = await fetch(`${API_URL}/api/csrf-token`, {
        credentials: "include",
        headers: { 'x-nyx-installation-id': await getClientInstallationId() },
        signal,
      });
      if (!res.ok) throw new Error(`Failed to fetch CSRF token: ${res.status}`);

      const data = await res.json();
      csrfTokenCache = data.csrfToken;
      return csrfTokenCache!;
    } catch (error) {
      console.error("Error fetching CSRF token:", error);
      // Jangan throw error di sini agar request GET biasa tetap jalan meski tanpa CSRF
      return "";
    } finally {
      cancel();
    }
  })();

  try {
    return await csrfTokenPromise;
  } finally {
    // Dibuka lagi setelah selesai supaya kegagalan (mis. offline) bisa dicoba ulang.
    csrfTokenPromise = null;
  }
}

export async function api<T = unknown>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const { anonymous = false, ...requestOptions } = options;
  const userHeaders = (requestOptions.headers as Record<string, string> | undefined) || {};
  const hasInstallationId = Object.keys(userHeaders).some(k => k.toLowerCase() === 'x-nyx-installation-id');
  const headers: Record<string, string> = {
    ...(anonymous || hasInstallationId ? {} : { 'x-nyx-installation-id': await getClientInstallationId() }),
    // [R2 2026-10-15] Versi build dikirim di setiap request. Server memakainya
    // untuk menolak klien yang terlalu tua untuk protokol terkini (426
    // `CLIENT_TOO_OLD`) — jalur ini yang membuat "klien lama kehilangan kunci
    // grup tanpa pesan" berubah menjadi pesan yang bisa ditindaklanjuti.
    [CLIENT_VERSION_HEADER]: CLIENT_VERSION_VALUE,
    ...userHeaders,
  };

  // Attach CSRF Token hanya untuk method non-GET (mutasi). Jalur anonim
  // (token di body) tidak punya cookie/sesi, jadi CSRF tidak berlaku — header
  // content-type tetap dipasang.
  if (options.method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method.toUpperCase())) {
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    if (!anonymous) {
      // Coba ambil token, kalau gagal lanjut aja (mungkin endpoint public)
      const token = await getCsrfToken().catch(() => "");
      if (token) headers['CSRF-Token'] = token;
    }
  }

  // Timeout mencakup SELURUH siklus request (fetch + pembacaan body) — cancel()
  // baru dipanggil di finally setelah body selesai dikonsumsi.
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const { signal: combinedSignal, cancel } = combineWithTimeout(timeoutMs, options.signal);

  try {
    const res = await fetch(API_URL + path, {
      cache: 'no-store', // Disable browser caching
      ...requestOptions,
      credentials: anonymous ? 'omit' : 'include', // Anonim: jangan kirim RefreshToken/Session
      headers,
      // SETELAH spread options: selalu pakai sinyal gabungan (timeout + eksternal)
      signal: combinedSignal,
    });

    // --- ERROR HANDLING BLOCK ---
    if (!res.ok) {
      const text = await res.text();
      
      // 1. Handle CSRF Invalid -> Clear Cache
      if (res.status === 403 && text.toLowerCase().includes('csrf')) {
          csrfTokenCache = null;
      }

      // 2. Parse Error Details (JSON vs HTML/Text)
      let details;
      let errorMessage = res.statusText;
      try {
        details = JSON.parse(text);
        if (details.error) errorMessage = details.error;
        if (details.message) errorMessage = details.message;
      } catch (e) {
        errorMessage = text || `Request failed with status ${res.status}`;
        details = { raw: text };
      }

      // 3a. [R2 2026-10-15] Klien terlalu tua (426 `CLIENT_TOO_OLD`). Toast-nya
      // `duration: Infinity` dan satu id: pesan ini tidak boleh lewat begitu saja
      // (pengguna akan terus kehilangan pesan grup sampai ia memperbarui), tapi
      // juga tidak boleh menumpuk jadi puluhan toast dari request paralel.
      if (res.status === 426 && details?.error === 'CLIENT_TOO_OLD') {
        // Import dinamis (pola yang sama dengan `@store/auth` di `authFetch`):
        // menarik i18next + backend HTTP-nya ke graf modul `api.ts` ikut menambah
        // request nyata untuk memuat berkas locale, dan itu mengacaukan pengukuran
        // request di modul ini (termasuk uji single-flight CSRF). Jalur ini jarang
        // terpicu, jadi biayanya nol di operasi normal.
        const { default: i18n } = await import('../i18n');
        toast.error(i18n.t('errors:client_too_old', { minimum: details.minimumVersion ?? '' }), {
          id: 'client-too-old',
          duration: Infinity,
          icon: '⬆️',
        });
      }

      // 3b. Handle Rate Limit (429) dengan Toast
      if (res.status === 429) {
        toast.error(errorMessage, {
          id: 'rate-limit-error', // ID biar gak muncul duplikat toast
          duration: 5000,
          icon: '⏳',
          style: {
            background: '#fee2e2',
            color: '#b91c1c',
            fontWeight: '600',
          }
        });
      }

      throw new ApiError(res.status, errorMessage, details);
    }

    if (res.status === 204) {
      return {} as T;
    }

    return await res.json();
  } catch (err) {
    // Timeout → ApiError(0) agar konsisten dengan jalur error jaringan lain;
    // abort dari PEMANGGIL (AbortError) diteruskan apa adanya.
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(0, `Request timeout setelah ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    cancel();
  }
}

/**
 * Wrapper untuk request yang butuh Auth.
 * Otomatis mencoba refresh token jika kena 401.
 */
export async function authFetch<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  try {
    return await api<T>(url, options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      const { useAuthStore, getLastRefreshFailureKind } = await import('@store/auth');
      const user = useAuthStore.getState().user;
      
      // GUEST users are ephemeral and don't support refresh tokens.
      // We should not trigger global logout logic for them.
      if (user?.role === 'GUEST' || user?.id.startsWith('guest_')) {
        throw err;
      }

      try {
        const success = await useAuthStore.getState().silentRefresh();

        if (success) {
          return await api<T>(url, options);
        } else {
          // [BUGFIX 2026-10-18] Hanya kegagalan OTORITATIF (401/403 dari
          // /api/auth/refresh) yang boleh memicu logout. Kegagalan transien
          // (offline, timeout, 5xx) tidak boleh me-revoke family: dulu satu
          // gangguan jaringan saat tab resume mematikan sesi di tab lain, dan
          // tab yang tertinggal lalu memicu deteksi "reuse" +
          // /login?reason=revoked.
          if (getLastRefreshFailureKind() !== 'transient') {
            if (onAuthFailure) await onAuthFailure();
          } else {
            console.warn('[Auth] Refresh gagal transien — sesi dipertahankan.');
          }
        }
      } catch (refreshErr) {
        console.error("Token refresh failed:", refreshErr);
        // Import/throw tak terduga di jalur refresh = transien; jangan logout.
        if (getLastRefreshFailureKind() !== 'transient') {
          if (onAuthFailure) await onAuthFailure();
        }
      }
    }
    throw err;
  }
}

export function handleApiError(e: unknown): string {
  if (e instanceof ApiError) {
    // Pesan spesifik dari backend lebih diprioritaskan
    if (e.message) return e.message;

    // Fallback status code
    switch (e.status) {
      case 0: return "Network error. Check your connection.";
      case 400: return "Invalid request.";
      case 401: return "Session expired. Please login again.";
      case 403: return "You don't have permission.";
      case 404: return "Resource not found.";
      case 429: return "Too many requests. Please wait.";
      case 500: return "Server internal error.";
      default: return `Error (${e.status})`;
    }
  }
  if (e instanceof Error) return e.message;
  return "An unexpected error occurred";
}

export interface PreKeyBundle {
  deviceId: string;
  identityKey: string;
  pqIdentityKey?: string;
  signingKey: string;
  signingKeyV2?: string | null;
  signedPreKey: {
    key: string;
    pqKey?: string;
    signature: string;
    pqSignature?: string;
  };
  oneTimePreKey?: {
    keyId: number;
    key: string;
    pqKey?: string;
  };
}

export async function getPreKeyBundle(userId: string): Promise<PreKeyBundle> {
  // NOTE: This returns the first device's bundle for simplicity in this version
  const bundles = await authFetch<Record<string, PreKeyBundle[]>>(`/api/keys/prekey-bundle/${userId}`);
  const userBundles = bundles[userId];
  if (!userBundles || userBundles.length === 0) throw new Error("User has no active devices");
  const firstBundle = userBundles[0];
  if (!firstBundle) throw new Error("User has no active devices");
  return firstBundle;
}

// Upload menggunakan XMLHttpRequest native (untuk Progress Bar)
export async function apiUpload<T = unknown>({
  path,
  formData,
  onUploadProgress,
}: {
  path: string;
  formData: FormData;
  onUploadProgress: (progress: number) => void;
}): Promise<T> {
  try {
    const csrfToken = await getCsrfToken().catch(() => "");
    const installationId = await getClientInstallationId();

    const data = await new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API_URL + path);
      xhr.withCredentials = true; // Kirim Cookie
      xhr.timeout = UPLOAD_TIMEOUT_MS; // [ROBUSTNESS] upload tak boleh menggantung selamanya
      xhr.setRequestHeader('CSRF-Token', csrfToken);
      xhr.setRequestHeader('x-nyx-installation-id', installationId);
      // [R2 2026-10-15] Sama seperti jalur `fetch` — upload juga membawa versi
      // build, supaya klien tua tidak lolos gerbang hanya karena memakai jalur ini.
      xhr.setRequestHeader(CLIENT_VERSION_HEADER, CLIENT_VERSION_VALUE);
      xhr.upload.onprogress = (e) => {
        const progress = Math.round((e.loaded * 100) / (e.total || 1));
        onUploadProgress(progress);
      };
      xhr.ontimeout = () => reject(new ApiError(0, `Upload timeout setelah ${UPLOAD_TIMEOUT_MS / 1000}s`));
      xhr.onload = () => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(xhr.responseText || 'null');
        } catch (_e) {
          parsed = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parsed as T);
        } else {
          const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
          const message = (typeof body.error === 'string' ? body.error : undefined)
            ?? (typeof body.message === 'string' ? body.message : undefined)
            ?? xhr.statusText;
          reject(new ApiError(xhr.status, message || 'Upload failed', body));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
      xhr.send(formData);
    });
    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      // Handle 429 di upload juga
      if (error.status === 429) {
        toast.error(error.message, { icon: '⏳', style: { background: '#fee2e2', color: '#b91c1c' } });
      }
      throw error;
    }
    throw error;
  }
}
