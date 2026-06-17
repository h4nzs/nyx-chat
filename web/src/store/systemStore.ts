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
      // Panggil fungsi api() secara langsung dan gunakan Generic untuk strict type
      const data = await api<SystemStatusResponse>('/api/system/status');
      
      // Jika custom fetch Anda MENGEMBALIKAN object { data: ... }, 
      // gunakan: const { data } = await api<{data: SystemStatusResponse}>('/system/status');
      
      set({ maintenance: data.maintenance, banner: data.banner });
    } catch (error) {
      console.error('Gagal mengecek status sistem', error);
    }
  },
}));
