import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';

export const ACCENT_COLORS = ['blue', 'green', 'purple', 'orange', 'red'] as const;

export type AccentColor = typeof ACCENT_COLORS[number];

type ThemeState = {
  theme: 'light' | 'dark';
  accent: AccentColor;
  toggleTheme: () => void;
  setAccent: (accent: AccentColor) => void;
};

const ThemeSchema = z.object({
  theme: z.enum(['light', 'dark']).optional(),
  accent: z.enum(['blue', 'green', 'purple', 'orange', 'red']).optional(),
}).passthrough();

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'dark',
      accent: 'purple', // Default accent color
      toggleTheme: () =>
        set((state) => ({
          theme: state.theme === 'dark' ? 'light' : 'dark',
        })),
      setAccent: (accent) => set({ accent }),
    }),
    {
      name: 'theme-storage', // name of the item in the storage (must be unique)
      merge: (persistedState: unknown, currentState) => {
        if (!persistedState || typeof persistedState !== 'object') return currentState;
        const parsed = ThemeSchema.safeParse(persistedState);
        if (parsed.success) {
            return { ...currentState, ...parsed.data };
        } else {
            console.warn("[Zustand Persist] Corrupted theme data in localStorage, dropping...");
            return currentState;
        }
      }
    }
  )
);
