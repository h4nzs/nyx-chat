import { useEffect, useRef, useState, useCallback } from 'react';
import { useCallStore } from '../store/callStore';
import { getSocket } from '../lib/socket';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

export const useWebRTC = () => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  
  const { 
    callState, 
    remoteUserId, 
    isVideoCall, 
    setCallState, 
    setIncomingCall, 
    setOutgoingCall,
    endCall 
  } = useCallStore();

  const cleanup = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);

    if (peerConnection.current) {
      peerConnection.current.ontrack = null;
      peerConnection.current.onicecandidate = null;
      peerConnection.current.close();
      peerConnection.current = null;
    }
    
    endCall();
  }, [endCall]);

  const createPeerConnection = useCallback((targetUserId: string) => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnection.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        getSocket()?.emit('webrtc:ice-candidate', { to: targetUserId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      }
    };

    return pc;
  }, []);

  const getMediaStream = useCallback(async (video: boolean) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video,
        audio: true,
      });
      setLocalStream(stream);
      localStreamRef.current = stream;
      return stream;
    } catch (error) {
      console.error('Error accessing media devices.', error);
      throw error;
    }
  }, []);

  const startCall = useCallback(async (to: string, isVideo: boolean, callerProfile: any) => {
    try {
      setOutgoingCall(to, isVideo, callerProfile);
      const stream = await getMediaStream(isVideo);
      const pc = createPeerConnection(to);
      
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      
      getSocket()?.emit('call:request', { to, isVideo, callerProfile });
    } catch (err) {
      console.error('Failed to start call', err);
      cleanup();
    }
  }, [getMediaStream, createPeerConnection, setOutgoingCall, cleanup]);

  const acceptCall = useCallback(async () => {
    if (!remoteUserId) return;
    
    try {
      const stream = await getMediaStream(isVideoCall);
      const pc = createPeerConnection(remoteUserId);
      
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      
      getSocket()?.emit('call:accept', { to: remoteUserId });
      setCallState('connected');
    } catch (err) {
      console.error('Failed to accept call', err);
      cleanup();
    }
  }, [remoteUserId, isVideoCall, getMediaStream, createPeerConnection, setCallState, cleanup]);

  const rejectCall = useCallback(() => {
    if (remoteUserId) {
      getSocket()?.emit('call:reject', { to: remoteUserId });
    }
    cleanup();
  }, [remoteUserId, cleanup]);

  const hangup = useCallback(() => {
    if (remoteUserId) {
      getSocket()?.emit('call:end', { to: remoteUserId });
    }
    cleanup();
  }, [remoteUserId, cleanup]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleIncomingCall = (data: { from: string, isVideo: boolean, callerProfile: any }) => {
      // Only accept incoming call if we are idle
      const currentState = useCallStore.getState().callState;
      if (currentState === 'idle') {
        setIncomingCall(data.from, data.isVideo, data.callerProfile);
      } else {
        socket.emit('call:reject', { to: data.from, reason: 'busy' });
      }
    };

    const handleCallAccepted = async (data: { from: string }) => {
      setCallState('connected');
      if (!peerConnection.current) return;
      
      try {
        const offer = await peerConnection.current.createOffer();
        await peerConnection.current.setLocalDescription(offer);
        socket.emit('webrtc:offer', { to: data.from, offer });
      } catch (e) {
        console.error('Failed to create offer', e);
        cleanup();
      }
    };

    const handleCallRejected = () => {
      cleanup();
    };

    const handleCallEnded = () => {
      cleanup();
    };

    const handleOffer = async (data: { from: string, offer: RTCSessionDescriptionInit }) => {
      if (!peerConnection.current) return;
      try {
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnection.current.createAnswer();
        await peerConnection.current.setLocalDescription(answer);
        socket.emit('webrtc:answer', { to: data.from, answer });
      } catch (e) {
        console.error('Failed to handle offer', e);
      }
    };

    const handleAnswer = async (data: { from: string, answer: RTCSessionDescriptionInit }) => {
      if (!peerConnection.current) return;
      try {
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (e) {
        console.error('Failed to handle answer', e);
      }
    };

    const handleIceCandidate = async (data: { from: string, candidate: RTCIceCandidateInit }) => {
      if (!peerConnection.current) return;
      try {
        await peerConnection.current.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.error('Failed to add ice candidate', e);
      }
    };

    socket.on('call:incoming', handleIncomingCall);
    socket.on('call:accepted', handleCallAccepted);
    socket.on('call:rejected', handleCallRejected);
    socket.on('call:ended', handleCallEnded);
    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:answer', handleAnswer);
    socket.on('webrtc:ice-candidate', handleIceCandidate);

    return () => {
      socket.off('call:incoming', handleIncomingCall);
      socket.off('call:accepted', handleCallAccepted);
      socket.off('call:rejected', handleCallRejected);
      socket.off('call:ended', handleCallEnded);
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice-candidate', handleIceCandidate);
    };
  }, [setIncomingCall, setCallState, cleanup]);

  return {
    localStream,
    remoteStream,
    callState,
    remoteUserId,
    isVideoCall,
    startCall,
    acceptCall,
    rejectCall,
    hangup,
  };
};