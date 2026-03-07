import { create } from 'zustand';

export type CallState = 'idle' | 'ringing' | 'calling' | 'connected';

interface CallStoreState {
  callState: CallState;
  remoteUserId: string | null;
  remoteUserProfile: any | null;
  isVideoCall: boolean;
  isReceivingCall: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMinimized: boolean;
  ephemeralCallKey: string | null;

  setCallState: (state: CallState) => void;
  setIncomingCall: (from: string, isVideo: boolean, profile: any, key?: string) => void;
  setOutgoingCall: (to: string, isVideo: boolean, profile: any, key: string) => void;
  setLocalStream: (stream: MediaStream | null) => void;
  setRemoteStream: (stream: MediaStream | null) => void;
  toggleMinimize: () => void;
  setMinimized: (minimized: boolean) => void;
  endCall: () => void;
  setCallKey: (key: string) => void;
  }

  export const useCallStore = create<CallStoreState>((set) => ({
  callState: 'idle',
  remoteUserId: null,
  remoteUserProfile: null,
  isVideoCall: false,
  isReceivingCall: false,
  localStream: null,
  remoteStream: null,
  isMinimized: false,
  ephemeralCallKey: null,

  setCallState: (state) => set({ callState: state }),
  setLocalStream: (stream) => set({ localStream: stream }),
  setRemoteStream: (stream) => set({ remoteStream: stream }),
  toggleMinimize: () => set((state) => ({ isMinimized: !state.isMinimized })),
  setMinimized: (minimized) => set({ isMinimized: minimized }),
  setCallKey: (key) => set({ ephemeralCallKey: key }),

  setIncomingCall: (from, isVideo, profile, key) => set({
    callState: 'ringing',
    remoteUserId: from,
    isVideoCall: isVideo,
    remoteUserProfile: profile,
    isReceivingCall: true,
    isMinimized: false,
    ephemeralCallKey: key || null,
  }),

  setOutgoingCall: (to, isVideo, profile, key) => set({
    callState: 'calling',
    remoteUserId: to,
    isVideoCall: isVideo,
    remoteUserProfile: profile,
    isReceivingCall: false,
    isMinimized: false,
    ephemeralCallKey: key,
  }),

  endCall: () => set({
    callState: 'idle',
    remoteUserId: null,
    remoteUserProfile: null,
    isVideoCall: false,
    isReceivingCall: false,
    localStream: null,
    remoteStream: null,
    isMinimized: false,
    ephemeralCallKey: null,
  }),
  }));