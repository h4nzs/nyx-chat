// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { getSocket } from './socket';
import { useCallStore } from '../store/callStore';
import { api } from './api';
import { asUserId } from '@nyx/shared';
import { WebRTCSignalingSchema } from '@nyx/shared';
import i18n from '../i18n';

let cachedIceServers: RTCIceServer[] | null = null;
let turnCacheExp = 0;

const getDynamicIceServers = async (): Promise<RTCIceServer[]> => {
  if (cachedIceServers && Date.now() < turnCacheExp) {
    return cachedIceServers;
  }
  try {
    const res = await api<{ iceServers: RTCIceServer[] }>('/api/keys/turn');
    if (res && res.iceServers) {
      cachedIceServers = res.iceServers;
      turnCacheExp = Date.now() + (12 * 60 * 60 * 1000); // Cache for 12 hours
      return cachedIceServers!;
    }
    throw new Error("Invalid format");
  } catch (err) {
    console.error('Failed to get TURN servers:', err);
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
};

const peerConnections = new Map<string, RTCPeerConnection>();
let localMediaStream: MediaStream | null = null;

export const replaceVideoTrack = async (newVideoTrack: MediaStreamTrack) => {
  peerConnections.forEach(async (pc) => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      }
  });

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
  if (peerConnections.size === 0) return 'Good';
  // Simplified: If any connection is poor, return poor.
  for (const pc of peerConnections.values()) {
      try {
        const stats = await pc.getStats();
        let rtt = 0;
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rtt = report.currentRoundTripTime || 0;
          }
        });
        if (rtt > 0.5) return 'Poor';
        if (rtt > 0.2) return 'Fair';
      } catch (e) {}
  }
  return 'Good';
};

export const cleanupCall = () => {
  if (localMediaStream) {
    localMediaStream.getTracks().forEach((track) => track.stop());
    localMediaStream = null;
  }
  
  peerConnections.forEach((pc) => {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.close();
  });
  peerConnections.clear();
  
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
  peerConnections.set(targetUserId, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSecureSignal(targetUserId, 'ice-candidate', { candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      useCallStore.getState().addRemoteStream(asUserId(targetUserId), event.streams[0]);
    }
  };

  // Add local tracks to this new connection
  if (localMediaStream) {
      localMediaStream.getTracks().forEach(track => pc.addTrack(track, localMediaStream!));
  }

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
  } catch (error: unknown) {
    console.error('Error accessing media devices.', error);
    // Show toast so it doesn't fail silently
    import('react-hot-toast').then(m => m.default.error(`Media Error: ${(error instanceof Error ? error.message : 'Unknown error') || 'Permission denied'}`));
    throw error;
  }
};

export const startCall = async (to: string, isVideo: boolean, callerProfile: MinimalProfile) => {
  try {
    const { generateCallKey, encryptCallSignal } = await import('../utils/crypto');
    const callKey = await generateCallKey();
    
    useCallStore.getState().setOutgoingCall(asUserId(to), isVideo, callerProfile, callKey);

    // --- FIX: Find the correct Conversation ID ---
    const { useConversationStore } = await import('../store/conversation');
    const { user: currentUser } = (await import('../store/auth')).useAuthStore.getState();

    const conversations = useConversationStore.getState().conversations;
    // Modified search to support group calls? 
    // For now, keeping logic for finding conversation. 'to' might be conversationId for groups or userId for 1:1.
    // If 'to' is a userId, we look for 1:1. If 'to' is conversationId, we use it directly.
    let conversation = conversations.find(c => c.id === to);
    
    if (!conversation) {
        // Fallback: Try to find 1:1 by participant
        conversation = conversations.find(c =>
          !c.isGroup &&
          c.participants.some((p: { userId?: string; id?: string }) => p.userId === to || p.id === to) &&
          c.participants.some((p: { userId?: string; id?: string }) => p.userId === currentUser?.id || p.id === currentUser?.id)
        );
    }

    if (!conversation) {
      throw new Error("Cannot start E2EE call: Conversation not found.");
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

    await getMediaStream(isVideo);
    // In Mesh, we don't create PC immediately in startCall for everyone? 
    // Or we initiate connections to all participants?
    // For now, we wait for them to join (signaling 'request' or they send 'accept' after getting CALL_INIT).
    // The current logic sends 'request' to 'to'. If 'to' is a user, it's 1:1.
    // If 'to' is a group, we might need to iterate participants.
    
    const iceServers = await getDynamicIceServers();

    if (conversation.isGroup) {
        // For groups, we might broadcast 'request' or wait? 
        // Simple Mesh: Send 'request' to all other participants.
        conversation.participants.forEach(p => {
            const pid = (p as { userId?: string; id: string }).userId || p.id;
            if (pid !== currentUser?.id) {
                 const pc = createPeerConnection(pid, iceServers);
                 // We create offer immediately? Or send 'request' first?
                 // Original logic sent 'request'.
                 // We can just send 'request' to notify them to ring.
                 // Encrypt payload
                 encryptCallSignal({ isVideo, callerProfile }, callKey).then(enc => {
                     getSocket()?.emit('webrtc:secure_signal', { to: pid, type: 'request', payload: enc });
                 });
            }
        });
    } else {
        // 1:1
        const pc = createPeerConnection(to, iceServers);
        // 2. Encrypt the signaling metadata and send via unified event
        const payload = { isVideo, callerProfile };
        const encryptedPayload = await encryptCallSignal(payload, callKey);
        getSocket()?.emit('webrtc:secure_signal', { to, type: 'request', payload: encryptedPayload });
    }

  } catch (err) {
    console.error('Failed to start call', err);
    import('react-hot-toast').then(m => m.default.error(i18n.t('errors:call_failed', 'Failed to start E2EE call.')));
    cleanupCall();
  }
};

export const acceptCall = async () => {
  const state = useCallStore.getState();
  // In mesh, we might be accepting a call from one person, but connecting to multiple?
  // Usually 'acceptCall' is triggered by user action.
  // We should signal 'accept' to the callers.
  // For now, we signal 'accept' to all known remote users (or the one who initiated).
  
  const initiators = state.remoteUsers; 
  if (initiators.length === 0) return;

  try {
    await getMediaStream(state.isVideoCall);
    const iceServers = await getDynamicIceServers();

    // Connect to all known remote users (initiators)
    initiators.forEach(user => {
        if (!peerConnections.has(user.id)) {
            createPeerConnection(user.id, iceServers);
        }
        sendSecureSignal(user.id, 'accept');
    });
    
    useCallStore.getState().setCallState('connected');
  } catch (err) {
    console.error('Failed to accept call', err);
    cleanupCall();
  }
};

export const rejectCall = () => {
  const state = useCallStore.getState();
  state.remoteUsers.forEach(u => sendSecureSignal(u.id, 'reject', { reason: 'declined' }));
  cleanupCall();
};

export const hangup = () => {
  const state = useCallStore.getState();
  state.remoteUsers.forEach(u => sendSecureSignal(u.id, 'end'));
  cleanupCall();
};

import type { Socket } from "socket.io-client";

import type { MinimalProfile } from '../store/callStore';

type SignalingPayload = 
  | { type?: string; isVideo: boolean; callerProfile: MinimalProfile }
  | { type?: string; offer: RTCSessionDescriptionInit }
  | { type?: string; answer: RTCSessionDescriptionInit }
  | { type?: string; candidate: RTCIceCandidateInit }
  | { type?: string; reason?: string; callerProfile?: MinimalProfile }
  | Record<string, unknown>;

export const initWebRTCListeners = (socket: Socket | null) => {
  if (!socket) return;

  if (socket.listeners('webrtc:secure_signal').length > 0) return;

  socket.on('webrtc:secure_signal', async (rawPayload: unknown) => {
    const parsed = WebRTCSignalingSchema.safeParse(rawPayload);

    if (!parsed.success) {
        console.error("[WebRTC Zod Shield] Dropping invalid signaling payload:", parsed.error.format());
        return; 
    }

    const data = parsed.data;
    const state = useCallStore.getState();
    let callKey = state.ephemeralCallKey;

    if (!callKey) {
        // ✅ FIX: Wait for up to 5 seconds for the callKey to be set by the E2EE CALL_INIT message
        // This solves the race condition where the fast WebRTC signal arrives before the heavy E2EE message is decrypted
        for (let i = 0; i < 50; i++) {
            await new Promise(r => setTimeout(r, 100));
            callKey = useCallStore.getState().ephemeralCallKey;
            if (callKey) break;
        }
        
        if (!callKey) {
            console.warn(`[WebRTC] SECURITY BLOCK: Dropping signal ${data.type} because callKey is missing after timeout.`);
            return;
        }
    }

    try {
        const { decryptCallSignal } = await import('../utils/crypto');
        
        let decryptedPayload: SignalingPayload;

        if (typeof data.payload === 'string') {
            decryptedPayload = (await decryptCallSignal(data.payload, callKey)) as SignalingPayload;
        } else if (import.meta.env.DEV && typeof data.payload === 'object' && data.payload !== null) {
            // ✅ HANYA UNTUK DEVELOPMENT: Mengizinkan debugging lokal tanpa enkripsi
            console.warn(`[WebRTC] DEV MODE: Menerima payload tidak terenkripsi untuk tipe ${data.type}`);
            decryptedPayload = data.payload as SignalingPayload;
        } else {
            // 🚨 PRODUCTION SHIELD: Tolak mentah-mentah jika bukan string terenkripsi!
            console.warn(`[WebRTC] SECURITY BLOCK: Dropping signal ${data.type} with unencrypted payload.`);
            return; // Berhenti memproses!
        }

        // ✅ FIX: Validate decrypted payload before processing
        if (data.type === 'request') {
            if (typeof (decryptedPayload as { isVideo?: unknown }).isVideo !== 'boolean') {
                console.warn('[WebRTC] Invalid request payload: isVideo missing or not boolean');
                return;
            }
        } else if (data.type === 'offer') {
            const payloadWithOffer = decryptedPayload as { offer?: { type?: string; sdp?: string } };
            const offer = payloadWithOffer.offer;
            if (!offer || typeof offer !== 'object' || offer.type !== 'offer' || typeof offer.sdp !== 'string') {
                console.warn('[WebRTC] Invalid offer payload');
                return;
            }
        } else if (data.type === 'answer') {
            const payloadWithAnswer = decryptedPayload as { answer?: { type?: string; sdp?: string } };
            const answer = payloadWithAnswer.answer;
            if (!answer || typeof answer !== 'object' || answer.type !== 'answer' || typeof answer.sdp !== 'string') {
                console.warn('[WebRTC] Invalid answer payload');
                return;
            }
        } else if (data.type === 'ice-candidate') {
            const candidate = (decryptedPayload as { candidate?: unknown }).candidate;
            if (!candidate || typeof candidate !== 'object') {
                console.warn('[WebRTC] Invalid ice candidate payload');
                return;
            }
        }

        let pc = peerConnections.get(data.from as string);

        switch (data.type) {
            case 'request':
                if (state.callState === 'idle') {
                    useCallStore.getState().setIncomingCall(data.from, (decryptedPayload as { isVideo: boolean }).isVideo, (decryptedPayload as { callerProfile: MinimalProfile }).callerProfile, callKey);
                } else {
                    if (state.ephemeralCallKey === callKey) {
                         useCallStore.getState().addRemoteUser((decryptedPayload as { callerProfile?: MinimalProfile }).callerProfile || { id: data.from });
                    } else {
                         sendSecureSignal(data.from as string, 'reject', { reason: 'busy' });
                    }
                }
                break;
            case 'accept':
                useCallStore.getState().setCallState('connected');
                useCallStore.getState().addRemoteUser({ id: data.from });

                if (!pc) {
                    const iceServers = await getDynamicIceServers();
                    pc = createPeerConnection(data.from as string, iceServers);
                }

                try {
                  const offer = await pc.createOffer();
                  await pc.setLocalDescription(offer);
                  sendSecureSignal(data.from as string, 'offer', { offer });
                } catch (e) {
                  console.error('Failed to create offer', e);
                }
                break;
            case 'reject':
            case 'end':
                if (pc) {
                    pc.close();
                    peerConnections.delete(data.from as string);
                }
                const store = useCallStore.getState();
                store.removeRemoteStream(data.from);
                store.removeRemoteUser(data.from);

                if (useCallStore.getState().remoteUsers.length === 0) {
                    cleanupCall();
                }
                break;
            case 'offer':
                if (!pc) {
                    const iceServers = await getDynamicIceServers();
                    pc = createPeerConnection(data.from as string, iceServers);
                }
                try {
                  await pc.setRemoteDescription(new RTCSessionDescription((decryptedPayload as { offer: RTCSessionDescriptionInit }).offer));
                  const answer = await pc.createAnswer();
                  await pc.setLocalDescription(answer);
                  sendSecureSignal(data.from as string, 'answer', { answer });
                } catch (e) {
                  console.error('Failed to handle offer', e);
                }
                break;
            case 'answer':
                if (!pc) return;
                try {
                  await pc.setRemoteDescription(new RTCSessionDescription((decryptedPayload as { answer: RTCSessionDescriptionInit }).answer));
                } catch (e) {
                  console.error('Failed to handle answer', e);
                }
                break;
            case 'ice-candidate':
                if (!pc) return;
                try {
                  await pc.addIceCandidate(new RTCIceCandidate((decryptedPayload as { candidate: RTCIceCandidateInit }).candidate));
                } catch (e) {
                  console.error('Failed to add ice candidate', e);
                }
                break;
        }
    } catch (e) {
        console.error(`Failed to decrypt and process secure signal ${data.type}`, e);
        if (e instanceof DOMException || (e as Error).name === 'OperationError') {
            console.warn(`[WebRTC] Invalid call key detected for peer ${data.from}. Removing peer from call.`);
            const peerIdStr = data.from as string;
            const pc = peerConnections.get(peerIdStr);
            if (pc) {
                pc.close();
                peerConnections.delete(peerIdStr);
            }
            const store = useCallStore.getState();
            store.removeRemoteStream(data.from);
            store.removeRemoteUser(data.from);

            if (useCallStore.getState().remoteUsers.length === 0) {
                console.warn(`[WebRTC] No peers left. Purging current call state to allow recovery.`);
                cleanupCall();
            }
        }
    }
  });
};