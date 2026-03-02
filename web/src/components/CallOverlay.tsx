import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiPhone, FiVideo, FiVideoOff, FiMic, FiMicOff, FiPhoneOff } from 'react-icons/fi';
import { useCallStore } from '../store/callStore';
import { acceptCall, rejectCall, hangup } from '../lib/webrtc';
import { toAbsoluteUrl } from '../utils/url';

export default function CallOverlay() {
  const { 
    callState, 
    remoteUserProfile, 
    isVideoCall, 
    isReceivingCall,
    localStream,
    remoteStream
  } = useCallStore();

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);

  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);

  useEffect(() => {
    // Initialize audio only once
    if (!ringtoneRef.current) {
      ringtoneRef.current = new Audio('/sounds/ringing.mp3');
      ringtoneRef.current.loop = true;
    }

    const audio = ringtoneRef.current;

    const isRinging = callState === 'calling' || callState === 'ringing';

    if (isRinging) {
      audio.play().catch(e => console.error("Audio play blocked by browser:", e));
    } else {
      audio.pause();
      audio.currentTime = 0;
    }

    // Cleanup on unmount
    return () => {
      audio.pause();
      audio.currentTime = 0;
    };
  }, [callState]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, callState]);

  useEffect(() => {
    if (remoteStream) {
      if (remoteVideoRef.current && isVideoCall) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
      if (remoteAudioRef.current && !isVideoCall) {
        remoteAudioRef.current.srcObject = remoteStream;
      }
    }
  }, [remoteStream, isVideoCall, callState]);

  const toggleMute = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!localStream.getAudioTracks()[0]?.enabled);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsVideoOff(!localStream.getVideoTracks()[0]?.enabled);
    }
  };

  if (callState === 'idle') return null;

  const profileName = remoteUserProfile?.name || 'Unknown User';
  const profileAvatar = toAbsoluteUrl(remoteUserProfile?.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profileName}`;

  return (
    <AnimatePresence>
      {callState === 'ringing' && isReceivingCall && (
        <motion.div 
          initial={{ opacity: 0 }} 
          animate={{ opacity: 1 }} 
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        >
          <motion.div 
            initial={{ scale: 0.9, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            className="bg-bg-surface/80 p-8 rounded-3xl border border-white/10 shadow-2xl flex flex-col items-center backdrop-blur-md min-w-[320px]"
          >
            <div className="relative mb-6">
              <div className="w-24 h-24 rounded-full overflow-hidden border-2 border-accent/50">
                <img src={profileAvatar} alt={profileName} className="w-full h-full object-cover" />
              </div>
              <div className="absolute inset-0 rounded-full border-4 border-accent animate-ping opacity-50"></div>
            </div>
            
            <h3 className="text-xl font-bold text-text-primary mb-1">{profileName}</h3>
            <p className="text-text-secondary mb-8">
              Incoming {isVideoCall ? 'Video' : 'Voice'} Call...
            </p>

            <div className="flex gap-6">
              <button 
                onClick={rejectCall}
                aria-label="Reject Call"
                className="w-14 h-14 rounded-full bg-red-500/20 text-red-500 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all shadow-lg hover:shadow-red-500/50"
              >
                <FiPhoneOff size={24} />
              </button>
              <button 
                onClick={acceptCall}
                aria-label={isVideoCall ? "Accept Video Call" : "Accept Audio Call"}
                className="w-14 h-14 rounded-full bg-green-500/20 text-green-500 hover:bg-green-500 hover:text-white flex items-center justify-center transition-all shadow-lg hover:shadow-green-500/50 animate-pulse"
              >
                {isVideoCall ? <FiVideo size={24} /> : <FiPhone size={24} />}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {(callState === 'calling' || callState === 'connected') && (
        <motion.div 
          initial={{ opacity: 0 }} 
          animate={{ opacity: 1 }} 
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] bg-black flex flex-col overflow-hidden"
        >
          <div className="flex-1 relative flex items-center justify-center w-full h-full">
            {isVideoCall ? (
              <>
                <video 
                  ref={remoteVideoRef} 
                  autoPlay 
                  playsInline 
                  className="absolute inset-0 w-full h-full object-cover"
                />
                <div className="absolute bottom-24 right-4 w-32 h-48 md:w-48 md:h-72 bg-gray-900 rounded-xl overflow-hidden shadow-2xl border border-white/20 z-10">
                  <video 
                    ref={localVideoRef} 
                    autoPlay 
                    playsInline 
                    muted 
                    className="w-full h-full object-cover"
                  />
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center">
                <audio ref={remoteAudioRef} autoPlay playsInline />
                <div className="relative mb-6">
                  <div className="w-32 h-32 rounded-full overflow-hidden border-2 border-accent/50 z-10 relative">
                    <img src={profileAvatar} alt={profileName} className="w-full h-full object-cover" />
                  </div>
                  {callState === 'connected' && (
                    <>
                      <div className="absolute inset-0 rounded-full border-2 border-accent animate-ping opacity-70"></div>
                      <div className="absolute inset-[-10px] rounded-full border border-accent/30 animate-ping" style={{ animationDelay: '0.2s' }}></div>
                    </>
                  )}
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">{profileName}</h2>
                <p className="text-gray-400">
                  {callState === 'calling' ? 'Calling...' : 'Connected'}
                </p>
              </div>
            )}
            
            {/* Overlay Gradient for controls */}
            <div className="absolute bottom-0 left-0 right-0 h-40 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />
          </div>

          <div className="absolute bottom-0 left-0 right-0 p-8 flex justify-center gap-6 z-20">
            <button 
              onClick={toggleMute}
              className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${isMuted ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'} backdrop-blur-md`}
            >
              {isMuted ? <FiMicOff size={24} /> : <FiMic size={24} />}
            </button>
            
            {isVideoCall && (
              <button 
                onClick={toggleVideo}
                className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${isVideoOff ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'} backdrop-blur-md`}
              >
                {isVideoOff ? <FiVideoOff size={24} /> : <FiVideo size={24} />}
              </button>
            )}

            <button 
              onClick={hangup}
              className="w-14 h-14 rounded-full bg-red-500 text-white hover:bg-red-600 flex items-center justify-center transition-all shadow-[0_0_20px_rgba(239,68,68,0.4)]"
            >
              <FiPhoneOff size={24} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
