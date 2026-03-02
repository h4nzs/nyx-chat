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
  
  setCallState: (state: CallState) => void;
  setIncomingCall: (from: string, isVideo: boolean, profile: any) => void;
  setOutgoingCall: (to: string, isVideo: boolean, profile: any) => void;
  setLocalStream: (stream: MediaStream | null) => void;
  setRemoteStream: (stream: MediaStream | null) => void;
  toggleMinimize: () => void;
  setMinimized: (minimized: boolean) => void;
  endCall: () => void;
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

  setCallState: (state) => set({ callState: state }),
  setLocalStream: (stream) => set({ localStream: stream }),
  setRemoteStream: (stream) => set({ remoteStream: stream }),
  toggleMinimize: () => set((state) => ({ isMinimized: !state.isMinimized })),
  setMinimized: (minimized) => set({ isMinimized: minimized }),
  
  setIncomingCall: (from, isVideo, profile) => set({
    callState: 'ringing',
    remoteUserId: from,
    isVideoCall: isVideo,
    remoteUserProfile: profile,
    isReceivingCall: true,
    isMinimized: false,
  }),

  setOutgoingCall: (to, isVideo, profile) => set({
    callState: 'calling',
    remoteUserId: to,
    isVideoCall: isVideo,
    remoteUserProfile: profile,
    isReceivingCall: false,
    isMinimized: false,
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
  }),
}));