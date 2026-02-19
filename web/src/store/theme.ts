import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const ACCENT_COLORS = ['blue', 'green', 'purple', 'orange', 'red'] as const;

export type AccentColor = typeof ACCENT_COLORS[number];

type ThemeState = {
  theme: 'light' | 'dark';
  accent: AccentColor;
  toggleTheme: () => void;
  setAccent: (accent: AccentColor) => void;
};

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
    }
  )
);
