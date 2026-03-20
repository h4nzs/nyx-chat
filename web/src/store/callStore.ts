import { create } from 'zustand';
import type { UserId } from '../types/brands';

export type CallState = 'idle' | 'ringing' | 'calling' | 'connected';

export type MinimalProfile = {
  id: UserId;
  name?: string;
  username?: string;
  avatarUrl?: string | null;
  [key: string]: unknown;
};

interface CallStoreState {
  callState: CallState;
  remoteUsers: MinimalProfile[];
  remoteStreams: Record<string, MediaStream>;
  isVideoCall: boolean;
  isReceivingCall: boolean;
  localStream: MediaStream | null;
  isMinimized: boolean;
  ephemeralCallKey: string | null;

  setCallState: (state: CallState) => void;
  setIncomingCall: (from: UserId, isVideo: boolean, profile: MinimalProfile, key?: string) => void;
  setOutgoingCall: (to: UserId | UserId[], isVideo: boolean, profile: MinimalProfile | MinimalProfile[], key: string) => void;
  setLocalStream: (stream: MediaStream | null) => void;
  addRemoteStream: (userId: UserId, stream: MediaStream) => void;
  removeRemoteStream: (userId: UserId) => void;
  addRemoteUser: (profile: MinimalProfile) => void;
  removeRemoteUser: (userId: UserId) => void;
  toggleMinimize: () => void;
  setMinimized: (minimized: boolean) => void;
  endCall: () => void;
  setCallKey: (key: string) => void;
}

export const useCallStore = create<CallStoreState>((set) => ({
  callState: 'idle',
  remoteUsers: [],
  remoteStreams: {},
  isVideoCall: false,
  isReceivingCall: false,
  localStream: null,
  isMinimized: false,
  ephemeralCallKey: null,

  setCallState: (state) => set({ callState: state }),
  setLocalStream: (stream) => set({ localStream: stream }),
  toggleMinimize: () => set((state) => ({ isMinimized: !state.isMinimized })),
  setMinimized: (minimized) => set({ isMinimized: minimized }),
  setCallKey: (key) => set({ ephemeralCallKey: key }),

  addRemoteStream: (userId, stream) => set((state) => ({
    remoteStreams: { ...state.remoteStreams, [userId]: stream }
  })),

  removeRemoteStream: (userId) => set((state) => {
    const newStreams = { ...state.remoteStreams };
    delete newStreams[userId];
    return { remoteStreams: newStreams };
  }),

  addRemoteUser: (profile) => set((state) => {
    if (state.remoteUsers.some(u => u.id === profile.id)) return state;
    return { remoteUsers: [...state.remoteUsers, profile] };
  }),

  removeRemoteUser: (userId) => set((state) => ({
    remoteUsers: state.remoteUsers.filter(u => u.id !== userId)
  })),

  setIncomingCall: (from, isVideo, profile, key) => set({
    callState: 'ringing',
    remoteUsers: [profile || { id: from, name: 'Unknown' }],
    isVideoCall: isVideo,
    isReceivingCall: true,
    isMinimized: false,
    ephemeralCallKey: key || null,
  }),

  setOutgoingCall: (to, isVideo, profile, key) => {
    // Handle both single ID (1:1) and array of IDs (Group)
    // If 'to' is array, 'profile' might be array or single object? 
    // Assuming simple init for now: users added incrementally or via 'profile' arg if it's an array.
    // Ideally 'to' implies IDs. We need profiles. 
    // For now, we initialize with minimal profile placeholders if actual profiles aren't passed fully.
    
    let initialUsers: MinimalProfile[] = [];
    if (Array.isArray(profile)) {
        initialUsers = profile;
    } else if (profile && !Array.isArray(profile)) {
        initialUsers = [profile];
    } else if (Array.isArray(to)) {
        initialUsers = to.map(id => ({ id, name: 'User' }));
    } else {
        initialUsers = [{ id: to as UserId, name: 'User' }];
    }

    set({
        callState: 'calling',
        remoteUsers: initialUsers,
        isVideoCall: isVideo,
        isReceivingCall: false,
        isMinimized: false,
        ephemeralCallKey: key,
    });
  },

  endCall: () => set({
    callState: 'idle',
    remoteUsers: [],
    remoteStreams: {},
    isVideoCall: false,
    isReceivingCall: false,
    localStream: null,
    isMinimized: false,
    ephemeralCallKey: null,
  }),
}));