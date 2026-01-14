import axios from 'axios';

// PERBAIKAN: Baca dari Environment Variable
const envUrl = import.meta.env.VITE_API_URL || "";

// Hapus '/api' di akhir URL jika user tidak sengaja memasukkannya di .env
// karena di kode bawah kita sudah menulis '/api/...' secara eksplisit.
const API_URL = envUrl.replace(/\/api\/?$/, "").replace(/\/$/, "");

// Cache untuk token CSRF
let csrfTokenCache: string | null = null;
// Handler for auth failure, to be injected from the UI layer
let onAuthFailure: (() => Promise<void>) | null = null;

/**
 * Injects a callback to be executed on a final, unrecoverable authentication failure.
 * This breaks the circular dependency between the api layer and the auth store.
 * @param handler The async function to call on auth failure (e.g., logout).
 */
export function setAuthFailureHandler(handler: () => Promise<void>) {
  onAuthFailure = handler;
}

/**
 * Mengambil token CSRF dari server dan menyimpannya di cache.
 */
export async function getCsrfToken(): Promise<string> {
  if (csrfTokenCache) {
    return csrfTokenCache;
  }
  try {
    const res = await fetch(`${API_URL}/api/csrf-token`, { credentials: "include" });
    if (!res.ok) {
      throw new Error(`Failed to fetch CSRF token: ${res.status}`);
    }
    const data = await res.json();
    csrfTokenCache = data.csrfToken;
    return csrfTokenCache!;
  } catch (error) {
    console.error("Error fetching CSRF token:", error);
    csrfTokenCache = null;
    throw error;
  }
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

export async function api<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  if (options.method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method.toUpperCase())) {
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    try {
      const token = await getCsrfToken();
      headers['CSRF-Token'] = token;
    } catch {
      console.error("Could not attach CSRF token");
    }
  }

  // API_URL sekarang sudah berisi domain Render yang benar
  const res = await fetch(API_URL + path, {
    ...options,
    credentials: "include",
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403 && text.includes('invalid csrf token')) {
        csrfTokenCache = null;
    }
    // Try to parse the error details from the response body
    let details;
    try {
      details = JSON.parse(text);
    } catch (e) {
      details = { message: text }; // Fallback for non-JSON responses
    }
    throw new ApiError(res.status, details.message || res.statusText, details);
  }

  if (res.status === 204) {
    return {} as T;
  }

  return res.json();
}

export async function authFetch<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  try {
    return await api<T>(url, options);
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.status === 401 || /Unauthorized/i.test(err.message))
    ) {
      try {
        const refreshRes = await api<{ ok: boolean }>("/api/auth/refresh", {
          method: "POST",
        });

        if (refreshRes.ok) {
          return await api<T>(url, options);
        }
        // If refresh fails, trigger the auth failure handler
        if (onAuthFailure) await onAuthFailure();
        throw err;
      } catch (refreshErr) {
        // This catch block handles failure of the refresh token endpoint itself
        if (onAuthFailure) await onAuthFailure();
        // Re-throw the original error that triggered the refresh attempt
        throw err;
      }
    }
    throw err;
  }
}

export function handleApiError(e: unknown): string {
  if (e instanceof ApiError) {
    // Prioritize specific error message from the server response body
    if (e.details?.message) return e.details.message;
    if (e.details?.error) return e.details.error;

    // Fallback to generic messages based on status code
    switch (e.status) {
      case 0:
        return "Network connection failed. Please check your internet connection.";
      case 400:
        return `Invalid request: ${e.message}`;
      case 401:
        return "Authentication failed. Please log in again.";
      case 403:
        return "Access denied. You don't have permission to perform this action.";
      case 404:
        return "Resource not found.";
      case 500:
        return "Server error. Please try again later.";
      default:
        return e.message || "An error occurred. Please try again.";
    }
  }

  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

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
    const csrfToken = await getCsrfToken();

    const response = await axios.post<T>(
      API_URL + path,
      formData,
      {
        withCredentials: true,
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
      throw new ApiError(
        error.response.status,
        error.response.data?.error || error.message,
        error.response.data
      );
    }
    throw error;
  }
}