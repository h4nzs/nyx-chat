import { getSocket } from './socket';
import { useCallStore } from '../store/callStore';

const ICE_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

let peerConnection: RTCPeerConnection | null = null;
let localMediaStream: MediaStream | null = null;
let isListenersInitialized = false;

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

const createPeerConnection = (targetUserId: string) => {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnection = pc;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      getSocket()?.emit('webrtc:ice-candidate', { to: targetUserId, candidate: event.candidate });
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
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    localMediaStream = stream;
    useCallStore.getState().setLocalStream(stream);
    return stream;
  } catch (error) {
    console.error('Error accessing media devices.', error);
    throw error;
  }
};

export const startCall = async (to: string, isVideo: boolean, callerProfile: any) => {
  try {
    useCallStore.getState().setOutgoingCall(to, isVideo, callerProfile);
    const stream = await getMediaStream(isVideo);
    const pc = createPeerConnection(to);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    getSocket()?.emit('call:request', { to, isVideo, callerProfile });
  } catch (err) {
    console.error('Failed to start call', err);
    cleanupCall();
  }
};

export const acceptCall = async () => {
  const state = useCallStore.getState();
  const remoteUserId = state.remoteUserId;
  if (!remoteUserId) return;
  
  try {
    const stream = await getMediaStream(state.isVideoCall);
    const pc = createPeerConnection(remoteUserId);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    
    getSocket()?.emit('call:accept', { to: remoteUserId });
    useCallStore.getState().setCallState('connected');
  } catch (err) {
    console.error('Failed to accept call', err);
    cleanupCall();
  }
};

export const rejectCall = () => {
  const remoteUserId = useCallStore.getState().remoteUserId;
  if (remoteUserId) getSocket()?.emit('call:reject', { to: remoteUserId });
  cleanupCall();
};

export const hangup = () => {
  const remoteUserId = useCallStore.getState().remoteUserId;
  if (remoteUserId) getSocket()?.emit('call:end', { to: remoteUserId });
  cleanupCall();
};

export const initWebRTCListeners = (socket: any) => {
  if (isListenersInitialized || !socket) return;
  isListenersInitialized = true;

  socket.on('call:incoming', (data: { from: string, isVideo: boolean, callerProfile: any }) => {
    const currentState = useCallStore.getState().callState;
    if (currentState === 'idle') {
      useCallStore.getState().setIncomingCall(data.from, data.isVideo, data.callerProfile);
    } else {
      socket.emit('call:reject', { to: data.from, reason: 'busy' });
    }
  });

  socket.on('call:accepted', async (data: { from: string }) => {
    useCallStore.getState().setCallState('connected');
    if (!peerConnection) return;
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc:offer', { to: data.from, offer });
    } catch (e) {
      console.error('Failed to create offer', e);
      cleanupCall();
    }
  });

  socket.on('call:rejected', cleanupCall);
  socket.on('call:ended', cleanupCall);

  socket.on('webrtc:offer', async (data: { from: string, offer: RTCSessionDescriptionInit }) => {
    if (!peerConnection) return;
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('webrtc:answer', { to: data.from, answer });
    } catch (e) {
      console.error('Failed to handle offer', e);
    }
  });

  socket.on('webrtc:answer', async (data: { from: string, answer: RTCSessionDescriptionInit }) => {
    if (!peerConnection) return;
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    } catch (e) {
      console.error('Failed to handle answer', e);
    }
  });

  socket.on('webrtc:ice-candidate', async (data: { from: string, candidate: RTCIceCandidateInit }) => {
    if (!peerConnection) return;
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (e) {
      console.error('Failed to add ice candidate', e);
    }
  });
};