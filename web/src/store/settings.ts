import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';

interface SettingsState {
  enableSmartReply: boolean;
  setEnableSmartReply: (val: boolean) => void;
  privacyCloak: boolean;
  setPrivacyCloak: (val: boolean) => void;
}

const SettingsSchema = z.object({
  enableSmartReply: z.boolean().optional(),
  privacyCloak: z.boolean().optional(),
}).passthrough();

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      enableSmartReply: false, // Default OFF for privacy
      setEnableSmartReply: (val) => set({ enableSmartReply: val }),
      privacyCloak: false,
      setPrivacyCloak: (val) => set({ privacyCloak: val }),
    }),
    { 
      name: 'nyx-app-settings',
      merge: (persistedState: unknown, currentState) => {
        if (!persistedState || typeof persistedState !== 'object') return currentState;
        const parsed = SettingsSchema.safeParse(persistedState);
        if (parsed.success) {
            return { ...currentState, ...parsed.data };
        } else {
            console.warn("[Zustand Persist] Corrupted settings data in localStorage, dropping...");
            return currentState;
        }
      }
    }
  )
);
