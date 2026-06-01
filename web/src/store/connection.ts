import { create } from 'zustand';
import { authFetch } from '@lib/api';

type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

export interface Device { 
  id: string; 
  isCurrent: boolean; 
  name: string; 
  lastActiveAt: string; 
  createdAt: string; 
}

interface ConnectionState {
  status: ConnectionStatus;
  myDevices: Device[];
  hasFetchedDevices: boolean;
  setStatus: (status: ConnectionStatus) => void;
  fetchMyDevices: (force?: boolean) => Promise<Device[]>;
}

let isFetchingDevices = false;

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: 'connecting',
  myDevices: [],
  hasFetchedDevices: false,
  
  setStatus: (status) => {
    set({ status });
    if (status === 'connected') {
      get().fetchMyDevices(true); // Re-fetch on reconnect
    }
  },

  fetchMyDevices: async (force = false) => {
    const { useAuthStore } = await import('./auth');
    if (!useAuthStore.getState().user) return [];

    const { hasFetchedDevices, myDevices } = get();
    if (!force && hasFetchedDevices) return myDevices;
    
    if (isFetchingDevices) {
      // Wait a bit if currently fetching
      await new Promise(r => setTimeout(r, 100));
      return get().myDevices;
    }

    isFetchingDevices = true;
    try {
      const devices = await authFetch<Device[]>('/api/users/me/devices');
      set({ myDevices: devices, hasFetchedDevices: true });
      return devices;
    } catch (e) {
      console.error("Failed to fetch devices:", e);
      return myDevices;
    } finally {
      isFetchingDevices = false;
    }
  }
}));
