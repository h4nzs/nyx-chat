import axios from 'axios';
import toast from 'react-hot-toast'; // Pastikan sudah diinstall

// PERBAIKAN: Baca dari Environment Variable
const envUrl = import.meta.env.VITE_API_URL || "";

// Hapus '/api' di akhir URL jika user tidak sengaja memasukkannya di .env
// Hasilnya bersih: "https://api.domain.com"
const API_URL = envUrl.replace(/\/api\/?$/, "").replace(/\/$/, "");

// Cache untuk token CSRF
let csrfTokenCache: string | null = null;
// Handler for auth failure (Logout)
let onAuthFailure: (() => Promise<void>) | null = null;

export function setAuthFailureHandler(handler: () => Promise<void>) {
  onAuthFailure = handler;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any
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
  
  try {
    const res = await fetch(`${API_URL}/api/csrf-token`, { credentials: "include" });
    if (!res.ok) throw new Error(`Failed to fetch CSRF token: ${res.status}`);
    
    const data = await res.json();
    csrfTokenCache = data.csrfToken;
    return csrfTokenCache!;
  } catch (error) {
    console.error("Error fetching CSRF token:", error);
    // Jangan throw error di sini agar request GET biasa tetap jalan meski tanpa CSRF
    return ""; 
  }
}

export async function api<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  // Attach CSRF Token hanya untuk method non-GET (mutasi)
  if (options.method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method.toUpperCase())) {
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    // Coba ambil token, kalau gagal lanjut aja (mungkin endpoint public)
    const token = await getCsrfToken().catch(() => "");
    if (token) headers['CSRF-Token'] = token;
  }

  const res = await fetch(API_URL + path, {
    ...options,
    credentials: "include", // Penting untuk kirim Cookie (RefreshToken/Session)
    headers,
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

    // 3. ✨ NEW: Handle Rate Limit (429) dengan Toast
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

  return res.json();
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
      try {
        // Coba refresh token
        const refreshRes = await api<{ ok: boolean }>("/api/auth/refresh", {
          method: "POST",
        });

        // Jika refresh sukses, ulangi request awal
        if (refreshRes) {
          return await api<T>(url, options);
        }
      } catch (refreshErr) {
        // Jika refresh gagal, biarkan lanjut ke logout logic di bawah
        console.error("Token refresh failed:", refreshErr);
      }

      // Jika sampai sini berarti refresh gagal/token expired permanen -> Logout
      if (onAuthFailure) await onAuthFailure();
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

// Upload menggunakan Axios (untuk Progress Bar)
export async function apiUpload<T = any>({
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

    const response = await axios.post<T>(
      API_URL + path, // Gunakan konstanta API_URL yang sama
      formData,
      {
        withCredentials: true, // Kirim Cookie
        headers: {
          'CSRF-Token': csrfToken,
        },
        onUploadProgress: (progressEvent) => {
          const progress = Math.round(
            (progressEvent.loaded * 100) / (progressEvent.total || 1)
          );
          onUploadProgress(progress);
        },
      }
    );
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      // Mapping Error Axios ke ApiError kita biar konsisten
      const message = error.response.data?.error || error.response.data?.message || error.message;
      
      // Handle 429 di upload juga
      if (error.response.status === 429) {
         toast.error(message, { icon: '⏳', style: { background: '#fee2e2', color: '#b91c1c' } });
      }

      throw new ApiError(
        error.response.status,
        message,
        error.response.data
      );
    }
    throw error;
  }
}