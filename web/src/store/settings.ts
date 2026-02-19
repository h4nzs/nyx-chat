import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  enableSmartReply: boolean;
  setEnableSmartReply: (val: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      enableSmartReply: false, // Default OFF for privacy
      setEnableSmartReply: (val) => set({ enableSmartReply: val }),
    }),
    { name: 'nyx-app-settings' }
  )
);
