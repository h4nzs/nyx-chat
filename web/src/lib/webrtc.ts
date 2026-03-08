// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { getSocket } from './socket';
import { useCallStore } from '../store/callStore';
import api from './api';

let cachedIceServers: RTCIceServer[] | null = null;
let turnCacheExp = 0;

const getDynamicIceServers = async (): Promise<RTCIceServer[]> => {
  if (cachedIceServers && Date.now() < turnCacheExp) {
    return cachedIceServers;
  }
  try {
    const res = await api.get('/keys/turn');
    if (res.data && res.data.iceServers) {
      cachedIceServers = res.data.iceServers;
      turnCacheExp = Date.now() + (12 * 60 * 60 * 1000); // Cache for 12 hours
      return cachedIceServers!;
    }
    throw new Error("Invalid format");
  } catch (err) {
    console.error('Failed to get TURN servers:', err);
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
};

let peerConnection: RTCPeerConnection | null = null;
let localMediaStream: MediaStream | null = null;

export const replaceVideoTrack = async (newVideoTrack: MediaStreamTrack) => {
  if (!peerConnection) return;
  const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
  if (sender) {
    await sender.replaceTrack(newVideoTrack);
  }

  if (localMediaStream) {
    localMediaStream.getVideoTracks().forEach(t => {
      t.stop();
      localMediaStream!.removeTrack(t);
    });
    localMediaStream.addTrack(newVideoTrack);
  } else {
    localMediaStream = new MediaStream([newVideoTrack]);
  }
};

export const getNetworkQuality = async (): Promise<'Good' | 'Fair' | 'Poor'> => {
  if (!peerConnection) return 'Good';
  try {
    const stats = await peerConnection.getStats();
    let rtt = 0;
    stats.forEach(report => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        rtt = report.currentRoundTripTime || 0;
      }
    });
    // RTT is in seconds. > 0.5s (500ms) is Poor. > 0.2s (200ms) is Fair.
    if (rtt > 0.5) return 'Poor';
    if (rtt > 0.2) return 'Fair';
    return 'Good';
  } catch (e) {
    return 'Good';
  }
};

export const cleanupCall = () => {
  if (localMediaStream) {
    localMediaStream.getTracks().forEach((track) => track.stop());
    localMediaStream = null;
  }
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.close();
    peerConnection = null;
  }
  useCallStore.getState().endCall();
};

const sendSecureSignal = async (to: string, type: string, payload: object = {}) => {
  const callKey = useCallStore.getState().ephemeralCallKey;
  if (!callKey) {
    console.error(`Cannot send secure signal ${type}: Missing Call Key`);
    return;
  }
  try {
    const { encryptCallSignal } = await import('../utils/crypto');
    const encryptedPayload = await encryptCallSignal(payload, callKey);
    getSocket()?.emit('webrtc:secure_signal', { to, type, payload: encryptedPayload });
  } catch (e) {
    console.error(`Failed to encrypt signal ${type}`, e);
  }
};

const createPeerConnection = (targetUserId: string, iceServers: RTCIceServer[]) => {
  const pc = new RTCPeerConnection({ iceServers });
  peerConnection = pc;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSecureSignal(targetUserId, 'ice-candidate', { candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      useCallStore.getState().setRemoteStream(event.streams[0]);
    }
  };

  return pc;
};

const getMediaStream = async (video: boolean) => {
  try {
    // Better constraints for mobile compatibility
    const constraints: MediaStreamConstraints = {
      audio: true,
      video: video ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localMediaStream = stream;
    useCallStore.getState().setLocalStream(stream);
    return stream;
  } catch (error: any) {
    console.error('Error accessing media devices.', error);
    // Show toast so it doesn't fail silently
    import('react-hot-toast').then(m => m.default.error(`Media Error: ${error.message || 'Permission denied'}`));
    throw error;
  }
};

export const startCall = async (to: string, isVideo: boolean, callerProfile: any) => {
  try {
    const { generateCallKey, encryptCallSignal } = await import('../utils/crypto');
    const callKey = await generateCallKey();
    
    useCallStore.getState().setOutgoingCall(to, isVideo, callerProfile, callKey);

    // --- FIX: Find the correct Conversation ID ---
    const { useConversationStore } = await import('../store/conversation');
    const { user: currentUser } = (await import('../store/auth')).useAuthStore.getState();

    const conversations = useConversationStore.getState().conversations;
    const conversation = conversations.find(c =>
      !c.isGroup &&
      c.participants.some((p: any) => p.userId === to || p.id === to) &&
      c.participants.some((p: any) => p.userId === currentUser?.id || p.id === currentUser?.id)
    );

    if (!conversation) {
      throw new Error("Cannot start E2EE call: No active 1-on-1 conversation found with this user.");
    }
    // --- END FIX ---

    // 1. Send Key via Ratcheted Double-Ratchet Channel (Silent Message)
    const { useMessageStore } = await import('../store/message');
    await useMessageStore.getState().sendMessage(conversation.id, { 
       content: JSON.stringify({ type: 'CALL_INIT', key: callKey }), 
       isSilent: true 
    });

    // Brief delay to ensure the key message hits the socket first
    await new Promise(r => setTimeout(r, 500));

    const stream = await getMediaStream(isVideo);
    const iceServers = await getDynamicIceServers();
    const pc = createPeerConnection(to, iceServers);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    
    // 2. Encrypt the signaling metadata and send via unified event
    const payload = { isVideo, callerProfile };
    const encryptedPayload = await encryptCallSignal(payload, callKey);
    
    getSocket()?.emit('webrtc:secure_signal', { to, type: 'request', payload: encryptedPayload });
  } catch (err) {
    console.error('Failed to start call', err);
    import('react-hot-toast').then(m => m.default.error('Failed to start E2EE call.'));
    cleanupCall();
  }
};

export const acceptCall = async () => {
  const state = useCallStore.getState();
  const remoteUserId = state.remoteUserId;
  if (!remoteUserId) return;
  
  try {
    const stream = await getMediaStream(state.isVideoCall);
    const iceServers = await getDynamicIceServers();
    const pc = createPeerConnection(remoteUserId, iceServers);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    
    sendSecureSignal(remoteUserId, 'accept');
    useCallStore.getState().setCallState('connected');
  } catch (err) {
    console.error('Failed to accept call', err);
    cleanupCall();
  }
};

export const rejectCall = () => {
  const remoteUserId = useCallStore.getState().remoteUserId;
  if (remoteUserId) sendSecureSignal(remoteUserId, 'reject', { reason: 'declined' });
  cleanupCall();
};

export const hangup = () => {
  const remoteUserId = useCallStore.getState().remoteUserId;
  if (remoteUserId) sendSecureSignal(remoteUserId, 'end');
  cleanupCall();
};

export const initWebRTCListeners = (socket: any) => {
  if (!socket) return;

  if (socket.listeners('webrtc:secure_signal').length > 0) return;

  socket.on('webrtc:secure_signal', async (data: { from: string, type: string, payload: string }) => {
    const state = useCallStore.getState();
    const callKey = state.ephemeralCallKey;

    // For 'request', the receiver MUST have the key already (sent via ratcheted message just before)
    if (!callKey) {
        console.warn(`Received secure signal ${data.type} but missing call key. Dropping.`);
        return;
    }

    try {
        const { decryptCallSignal } = await import('../utils/crypto');
        const decryptedPayload = await decryptCallSignal(data.payload, callKey);

        switch (data.type) {
            case 'request':
                if (state.callState === 'idle') {
                    useCallStore.getState().setIncomingCall(data.from, decryptedPayload.isVideo, decryptedPayload.callerProfile, callKey);
                } else {
                    sendSecureSignal(data.from, 'reject', { reason: 'busy' });
                }
                break;
            case 'accept':
                useCallStore.getState().setCallState('connected');
                if (!peerConnection) return;
                try {
                  const offer = await peerConnection.createOffer();
                  await peerConnection.setLocalDescription(offer);
                  sendSecureSignal(data.from, 'offer', { offer });
                } catch (e) {
                  console.error('Failed to create offer', e);
                  cleanupCall();
                }
                break;
            case 'reject':
            case 'end':
                cleanupCall();
                break;
            case 'offer':
                if (!peerConnection) return;
                try {
                  await peerConnection.setRemoteDescription(new RTCSessionDescription(decryptedPayload.offer));
                  const answer = await peerConnection.createAnswer();
                  await peerConnection.setLocalDescription(answer);
                  sendSecureSignal(data.from, 'answer', { answer });
                } catch (e) {
                  console.error('Failed to handle offer', e);
                }
                break;
            case 'answer':
                if (!peerConnection) return;
                try {
                  await peerConnection.setRemoteDescription(new RTCSessionDescription(decryptedPayload.answer));
                } catch (e) {
                  console.error('Failed to handle answer', e);
                }
                break;
            case 'ice-candidate':
                if (!peerConnection) return;
                try {
                  await peerConnection.addIceCandidate(new RTCIceCandidate(decryptedPayload.candidate));
                } catch (e) {
                  console.error('Failed to add ice candidate', e);
                }
                break;
        }
    } catch (e) {
        console.error(`Failed to decrypt and process secure signal ${data.type}`, e);
    }
  });
};