import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';

interface SettingsState {
  privacyCloak: boolean;
  setPrivacyCloak: (val: boolean) => void;
  // [T4] Cover traffic (doc 26.10) — client-local state. Server tidak boleh
  // tahu percakapan mana yang menjalankan cover (itu menandai pesannya).
  /** Master kill-switch: false → tidak pernah kirim cover apa pun. */
  coverTrafficMasterEnabled: boolean;
  setCoverTrafficMasterEnabled: (val: boolean) => void;
  /** Conversation IDs dengan privacy level Maximum (client-local enumeration). */
  coverTrafficMaximumGroups: string[];
  setGroupCoverTraffic: (conversationId: string, enabled: boolean) => void;
  // [26.10.5] Bundle Maximum — ephemeral receipts. Client-local seperti cover:
  // server tidak boleh tahu pengaturan privasi percakapan.
  /** Grup yang mengirim receipt ephemeral (delay acak + tanpa persist status). */
  ephemeralReceiptsGroups: string[];
  setGroupEphemeralReceipts: (conversationId: string, enabled: boolean) => void;
}

const SettingsSchema = z.object({
  privacyCloak: z.boolean().optional(),
  coverTrafficMasterEnabled: z.boolean().optional(),
  coverTrafficMaximumGroups: z.array(z.string()).optional(),
  ephemeralReceiptsGroups: z.array(z.string()).optional(),
}).passthrough();

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      privacyCloak: false,
      setPrivacyCloak: (val) => set({ privacyCloak: val }),
      coverTrafficMasterEnabled: true,
      setCoverTrafficMasterEnabled: (val) => set({ coverTrafficMasterEnabled: val }),
      coverTrafficMaximumGroups: [],
      setGroupCoverTraffic: (conversationId, enabled) =>
        set((s) => ({
          coverTrafficMaximumGroups: enabled
            ? Array.from(new Set([...s.coverTrafficMaximumGroups, conversationId]))
            : s.coverTrafficMaximumGroups.filter((id) => id !== conversationId),
        })),
      ephemeralReceiptsGroups: [],
      setGroupEphemeralReceipts: (conversationId, enabled) =>
        set((s) => ({
          ephemeralReceiptsGroups: enabled
            ? Array.from(new Set([...s.ephemeralReceiptsGroups, conversationId]))
            : s.ephemeralReceiptsGroups.filter((id) => id !== conversationId),
        })),
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
