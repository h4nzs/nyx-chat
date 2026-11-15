/// <reference types="vite/client" />

declare module 'libsodium-wrappers';
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_TRANSPORT_URL: string;
  readonly VITE_TRANSPORT_CERT_HASH: string;
  readonly VITE_OHTTP_TOKEN_MODE?: string;
  readonly VITE_PIR_OPRF_ENABLED?: string;
  readonly VITE_PIR_ENABLED?: string;
  /** Kunci publik ML-DSA-65 per server manifest: JSON { "a": "<base64url>" }. */
  readonly VITE_PIR_MANIFEST_KEYS?: string;
  /** Dua relay OHTTP (dipisah koma) — satu per server PIR. */
  readonly VITE_PIR_RELAYS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  [key: `sys_key_req_reply_${string}`]: number | undefined;
  [key: `last_repair_history_${string}`]: number | undefined;
  [key: `last_repair_${string}`]: number | undefined;
  _nyxBlobCache?: Map<string, string>;
}

interface Navigator {
  deviceMemory?: number;
}
