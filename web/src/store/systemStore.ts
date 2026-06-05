import { create } from 'zustand';
import { api } from '../lib/api';

// Definisikan struktur balikan dari API agar TypeScript (dan Generic T) tidak bingung
interface SystemStatusResponse {
  maintenance: boolean;
  banner: {
    active: boolean;
    message: string;
    type: 'info' | 'warning' | 'error';
  };
}

interface SystemState extends SystemStatusResponse {
  checkStatus: () => Promise<void>;
}

export const useSystemStore = create<SystemState>((set) => ({
  maintenance: false,
  banner: { active: false, message: '', type: 'info' },
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
