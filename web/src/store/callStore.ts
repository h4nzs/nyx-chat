import { create } from 'zustand';
import type { UserId, MinimalProfile } from '../types/core';
export type { MinimalProfile };

export type CallState = 'idle' | 'ringing' | 'calling' | 'connected';

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
  setIncomingCall: (from: UserId, isVideo: boolean, profile?: MinimalProfile, key?: string) => void;
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
    remoteUsers: profile ? [profile] : [],
    isVideoCall: isVideo,
    isReceivingCall: true,
    isMinimized: false,
    ephemeralCallKey: key || null,
  }),

  setOutgoingCall: (to, isVideo, profile, key) => {
    const initialUsers = Array.isArray(profile) ? profile : (profile ? [profile] : []);

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