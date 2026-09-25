import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';

interface SettingsState {
  privacyCloak: boolean;
  setPrivacyCloak: (val: boolean) => void;
}

const SettingsSchema = z.object({
  privacyCloak: z.boolean().optional(),
}).passthrough();

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
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
