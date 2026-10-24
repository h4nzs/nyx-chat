import { create } from 'zustand';
import { api } from '../lib/api';
import { isServerUnreachable } from '../lib/serverReachability';

// Definisikan struktur balikan dari API agar TypeScript (dan Generic T) tidak bingung
interface Banner {
  active: boolean;
  message: string;
  type: 'info' | 'warning' | 'error';
  alertType?: string;
  actionText?: string;
  actionLink?: string;
}

interface SystemStatusResponse {
  maintenance: boolean;
  banner: Banner;
}

interface SystemState extends SystemStatusResponse {
  /** true bila server tidak terjangkau (terkonfirmasi 2x) — memicu ServerDownPage. */
  serverUnreachable: boolean;
  checkStatus: () => Promise<void>;
  setBanner: (banner: Banner) => void;
}

// Timeout pendek khusus endpoint ini (default api() = 30 dtk terlalu lama untuk deteksi).
const STATUS_TIMEOUT_MS = 8_000;
// Satu blip jaringan jangan langsung menutup layar pengguna: konfirmasi sekali lagi.
const CONFIRM_DELAY_MS = 2_500;

const fetchStatus = () =>
  api<SystemStatusResponse>('/api/system/status', { timeoutMs: STATUS_TIMEOUT_MS });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Single-flight: interval 60 dtk, tombol retry, dan polling ServerDownPage tidak
// boleh menumpuk request paralel.
let inflight: Promise<void> | null = null;

export const useSystemStore = create<SystemState>((set) => {
  const run = async (): Promise<void> => {
    let data: SystemStatusResponse | undefined;
    try {
      data = await fetchStatus();
    } catch (first) {
      if (!isServerUnreachable(first)) {
        console.error('Gagal mengecek status sistem', first);
        return;
      }
      await sleep(CONFIRM_DELAY_MS);
      try {
        data = await fetchStatus();
      } catch (second) {
        if (isServerUnreachable(second)) set({ serverUnreachable: true });
        else console.error('Gagal mengecek status sistem', second);
        return;
      }
    }

    set((state) => {
      if (!data?.banner) return { serverUnreachable: false };
      const isPersonalAlertActive = state.banner.active && state.banner.alertType !== undefined;
      return {
        serverUnreachable: false,
        maintenance: data.maintenance,
        banner: data.banner.active
          ? data.banner
          : (isPersonalAlertActive ? state.banner : data.banner)
      };
    });
  };

  return {
    maintenance: false,
    serverUnreachable: false,
    banner: { active: false, message: '', type: 'info' },
    setBanner: (banner) => set({ banner }),
    checkStatus: () => {
      if (!inflight) {
        inflight = run().finally(() => { inflight = null; });
      }
      return inflight;
    },
  };
});
