import { create } from 'zustand';
import { api } from '../lib/api';

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
  checkStatus: () => Promise<void>;
  setBanner: (banner: Banner) => void;
}

export const useSystemStore = create<SystemState>((set) => ({
  maintenance: false,
  banner: { active: false, message: '', type: 'info' },
  setBanner: (banner) => set({ banner }),
  checkStatus: async () => {
    try {
      const data = await api<SystemStatusResponse>('/api/system/status');
      if (data) {
        set((state) => {
          const isPersonalAlertActive = state.banner.active && state.banner.alertType !== undefined;
          return {
            maintenance: data.maintenance,
            banner: data.banner.active
              ? data.banner
              : (isPersonalAlertActive ? state.banner : data.banner)
          };
        });
      }
    } catch (error) {
      console.error('Gagal mengecek status sistem', error);
    }
  },
}));
