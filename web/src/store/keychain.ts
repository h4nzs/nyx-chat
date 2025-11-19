import { create } from 'zustand';

interface KeychainState {
  // A simple timestamp to trigger re-renders when keys are updated.
  lastUpdated: number;
  // Action to update the timestamp.
  keysUpdated: () => void;
}

export const useKeychainStore = create<KeychainState>((set) => ({
  lastUpdated: Date.now(),
  keysUpdated: () => set({ lastUpdated: Date.now() }),
}));
