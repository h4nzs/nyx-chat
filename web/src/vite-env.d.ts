/// <reference types="vite/client" />

declare module 'libsodium-wrappers';
declare module 'react-window';
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_TRANSPORT_URL: string;
  readonly VITE_TRANSPORT_CERT_HASH: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  [key: `sys_key_req_reply_${string}`]: number | undefined;
  [key: `last_repair_history_${string}`]: number | undefined;
  [key: `last_repair_${string}`]: number | undefined;
}
