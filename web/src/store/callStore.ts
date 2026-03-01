import { create } from 'zustand';

export type CallState = 'idle' | 'ringing' | 'calling' | 'connected';

interface CallStoreState {
  callState: CallState;
  remoteUserId: string | null;
  remoteUserProfile: any | null;
  isVideoCall: boolean;
  isReceivingCall: boolean;
  
  setCallState: (state: CallState) => void;
  setIncomingCall: (from: string, isVideo: boolean, profile: any) => void;
  setOutgoingCall: (to: string, isVideo: boolean, profile: any) => void;
  endCall: () => void;
}

export const useCallStore = create<CallStoreState>((set) => ({
  callState: 'idle',
  remoteUserId: null,
  remoteUserProfile: null,
  isVideoCall: false,
  isReceivingCall: false,

  setCallState: (state) => set({ callState: state }),
  
  setIncomingCall: (from, isVideo, profile) => set({
    callState: 'ringing',
    remoteUserId: from,
    isVideoCall: isVideo,
    remoteUserProfile: profile,
    isReceivingCall: true,
  }),

  setOutgoingCall: (to, isVideo, profile) => set({
    callState: 'calling',
    remoteUserId: to,
    isVideoCall: isVideo,
    remoteUserProfile: profile,
    isReceivingCall: false,
  }),

  endCall: () => set({
    callState: 'idle',
    remoteUserId: null,
    remoteUserProfile: null,
    isVideoCall: false,
    isReceivingCall: false,
  }),
}));