import { AuthPayload } from './auth';

declare module 'socket.io' {
  interface Socket {
    user?: AuthPayload;
    /**
     * [docs/29 §5.6] Kapabilitas yang diiklankan klien di
     * `handshake.auth.capabilities` — sudah dibersihkan dari input jaringan
     * (`utils/transportCapability.ts`), kosong = klien legacy.
     */
    announcedCapabilities?: string[];
  }
}
