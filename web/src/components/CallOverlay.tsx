import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiPhone, FiVideo, FiVideoOff, FiMic, FiMicOff, FiPhoneOff, FiMinimize2, FiMaximize2, FiRefreshCw, FiWifi, FiVolume2, FiVolumeX, FiMonitor } from 'react-icons/fi';
import { useCallStore } from '../store/callStore';
import { acceptCall, rejectCall, hangup, replaceVideoTrack, getNetworkQuality } from '../lib/webrtc';
import { toAbsoluteUrl } from '../utils/url';
import toast from 'react-hot-toast';

export default function CallOverlay() {
  const { 
    callState, 
    remoteUserProfile, 
    isVideoCall, 
    isReceivingCall,
    localStream,
    remoteStream,
    isMinimized,
    toggleMinimize
  } = useCallStore();

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);

  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [networkQuality, setNetworkQuality] = useState<'Good' | 'Fair' | 'Poor'>('Good');
  const [isSpeakerphone, setIsSpeakerphone] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const originalVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);

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

  useEffect(() => {
    if (callState !== 'connected') return;
    const interval = setInterval(async () => {
      const quality = await getNetworkQuality();
      setNetworkQuality(quality);
    }, 2000);
    return () => clearInterval(interval);
  }, [callState]);

  const handleFlipCamera = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const newMode = facingMode === 'user' ? 'environment' : 'user';
      // Request new camera
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: newMode } } });
      const newVideoTrack = newStream.getVideoTracks()[0];

      // Call WebRTC helper to send the new track to the peer
      await replaceVideoTrack(newVideoTrack);

      // Update local video element.
      if (localVideoRef.current) {
        const oldStream = localVideoRef.current.srcObject as MediaStream;
        if (oldStream) oldStream.getVideoTracks().forEach(t => t.stop()); // Stop old camera

        // Create a new stream for the local preview containing the new video track
        const updatedLocalStream = new MediaStream([newVideoTrack]);
        localVideoRef.current.srcObject = updatedLocalStream;
      }
      setFacingMode(newMode);
    } catch (err) {
      console.error("Camera switch failed:", err);
      toast.error("Secondary camera not found");
    }
  };

  const handleToggleSpeaker = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const videoEl = remoteVideoRef.current || remoteAudioRef.current; // Use the active ref
    if (!videoEl) return;

    if (!('setSinkId' in videoEl)) {
      toast('Speaker toggle not supported on this browser/device', { icon: '⚠️' });
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOuts = devices.filter(d => d.kind === 'audiooutput');
      if (audioOuts.length < 2) {
        toast('No alternative audio outputs found', { icon: 'ℹ️' });
        return;
      }

      // Toggle logic (picks the next available audio output)
      const targetId = isSpeakerphone ? audioOuts[0].deviceId : audioOuts[audioOuts.length - 1].deviceId;
      await (videoEl as any).setSinkId(targetId);
      setIsSpeakerphone(!isSpeakerphone);
      toast.success(isSpeakerphone ? 'Switched to Earpiece' : 'Switched to Speaker');
    } catch (err) {
      console.error("Speaker toggle error:", err);
      toast.error("Could not switch audio output");
    }
  };

  const handleToggleScreenShare = async (e: React.MouseEvent) => {
    e.stopPropagation();

    try {
      if (isScreenSharing) {
        // --- STOP SCREEN SHARING ---
        if (screenTrackRef.current) {
          screenTrackRef.current.stop();
          screenTrackRef.current = null;
        }

        // Revert to original camera track
        if (originalVideoTrackRef.current) {
          await replaceVideoTrack(originalVideoTrackRef.current);
          if (localVideoRef.current) {
            const stream = localVideoRef.current.srcObject as MediaStream;
            if (stream) {
              stream.getVideoTracks().forEach(t => t.stop()); // Stop old screen track in local preview
              localVideoRef.current.srcObject = new MediaStream([originalVideoTrackRef.current, ...stream.getAudioTracks()]);
            }
          }
        }
        setIsScreenSharing(false);
        toast.success("Screen sharing stopped");

      } else {
        // --- START SCREEN SHARING ---
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = displayStream.getVideoTracks()[0];
        screenTrackRef.current = screenTrack;

        // Save the current camera track so we can revert later
        if (localVideoRef.current) {
            const currentStream = localVideoRef.current.srcObject as MediaStream;
            if (currentStream && currentStream.getVideoTracks().length > 0) {
                originalVideoTrackRef.current = currentStream.getVideoTracks()[0].clone(); // Clone to keep it alive
            }
        }

        // Send screen track to peer
        await replaceVideoTrack(screenTrack);

        // Show screen track on local preview
        if (localVideoRef.current) {
            const stream = localVideoRef.current.srcObject as MediaStream;
            if (stream) stream.getVideoTracks().forEach(t => t.stop()); // Stop camera on local preview
            localVideoRef.current.srcObject = new MediaStream([screenTrack, ...(stream?.getAudioTracks() || [])]);
        }

        setIsScreenSharing(true);
        toast.success("Screen sharing started");

        // Handle native browser "Stop Sharing" button
        screenTrack.onended = async () => {
            setIsScreenSharing(false);
            screenTrackRef.current = null;
            if (originalVideoTrackRef.current) {
                await replaceVideoTrack(originalVideoTrackRef.current);
                if (localVideoRef.current) {
                    const stream = localVideoRef.current.srcObject as MediaStream;
                    localVideoRef.current.srcObject = new MediaStream([originalVideoTrackRef.current, ...(stream?.getAudioTracks() || [])]);
                }
            }
        };
      }
    } catch (err) {
      console.error("Screen share error:", err);
      toast.error("Failed to share screen");
    }
  };

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
          onClick={() => { if (isMinimized) toggleMinimize(); }}
          className={
            isMinimized 
            ? "fixed bottom-20 right-4 w-28 h-40 sm:w-48 sm:h-72 z-[9999] bg-bg-main/90 backdrop-blur-md rounded-2xl shadow-2xl overflow-hidden cursor-pointer border border-white/10 transition-all duration-300 hover:scale-105 group"
            : "fixed inset-0 z-[9999] bg-black flex flex-col overflow-hidden transition-all duration-300"
          }
        >
          {!isMinimized && (
            <button 
              onClick={(e) => { e.stopPropagation(); toggleMinimize(); }} 
              className="p-3 bg-white/10 hover:bg-white/20 rounded-full backdrop-blur-md transition-all text-white absolute top-6 left-6 z-50"
              title="Minimize Call"
            >
              <FiMinimize2 size={24} />
            </button>
          )}

          {isMinimized && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-50">
               <FiMaximize2 size={32} className="text-white drop-shadow-md" />
            </div>
          )}

          {callState === 'connected' && !isMinimized && (
            <div className={`absolute top-6 right-20 px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-2 shadow-lg backdrop-blur-md transition-colors ${networkQuality === 'Poor' ? 'bg-red-500/80' : networkQuality === 'Fair' ? 'bg-yellow-500/80' : 'bg-green-500/80'} text-white z-50`}>
              <FiWifi /> {networkQuality}
            </div>
          )}

          <div className="flex-1 relative flex items-center justify-center w-full h-full">
            {isVideoCall ? (
              <>
                <video 
                  ref={remoteVideoRef} 
                  autoPlay 
                  playsInline 
                  className="absolute inset-0 w-full h-full object-cover"
                />
                {!isMinimized && (
                  <div className="absolute bottom-24 right-4 w-32 h-48 md:w-48 md:h-72 bg-gray-900 rounded-xl overflow-hidden shadow-2xl border border-white/20 z-10">
                    <video 
                      ref={localVideoRef} 
                      autoPlay 
                      playsInline 
                      muted 
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center w-full h-full bg-bg-surface">
                <audio ref={remoteAudioRef} autoPlay playsInline />
                <div className="relative mb-2">
                  <div className={`rounded-full overflow-hidden border-2 border-accent/50 z-10 relative ${isMinimized ? 'w-16 h-16' : 'w-32 h-32 mb-6'}`}>
                    <img src={profileAvatar} alt={profileName} className="w-full h-full object-cover" />
                  </div>
                  {callState === 'connected' && (
                    <>
                      <div className="absolute inset-0 rounded-full border-2 border-accent animate-ping opacity-70"></div>
                      <div className="absolute inset-[-10px] rounded-full border border-accent/30 animate-ping" style={{ animationDelay: '0.2s' }}></div>
                    </>
                  )}
                </div>
                {!isMinimized && (
                  <>
                    <h2 className="text-2xl font-bold text-white mb-2">{profileName}</h2>
                    <p className="text-gray-400">
                      {callState === 'calling' ? 'Calling...' : 'Connected'}
                    </p>
                  </>
                )}
              </div>
            )}
            
            {/* Overlay Gradient for controls */}
            {!isMinimized && (
               <div className="absolute bottom-0 left-0 right-0 h-40 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />
            )}
          </div>

          {!isMinimized && (
            <div className="absolute bottom-0 left-0 right-0 p-8 flex justify-center gap-6 z-20">
              {/* Flip Camera (Only if Video Call) */}
              {isVideoCall && (
                <button onClick={handleFlipCamera} className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all backdrop-blur-md">
                  <FiRefreshCw size={20} />
                </button>
              )}
              
              {/* Screen Share Toggle (Only for Video Calls) */}
              {isVideoCall && (
                <button 
                  onClick={handleToggleScreenShare} 
                  className={`w-12 h-12 rounded-full ${isScreenSharing ? 'bg-blue-500' : 'bg-white/10 hover:bg-white/20'} text-white flex items-center justify-center transition-all backdrop-blur-md`}
                  title={isScreenSharing ? "Stop Sharing" : "Share Screen"}
                >
                  <FiMonitor size={20} />
                </button>
              )}

              <button 
                onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${isMuted ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'} backdrop-blur-md`}
              >
                {isMuted ? <FiMicOff size={24} /> : <FiMic size={24} />}
              </button>
              
              {isVideoCall && (
                <button 
                  onClick={(e) => { e.stopPropagation(); toggleVideo(); }}
                  className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${isVideoOff ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'} backdrop-blur-md`}
                >
                  {isVideoOff ? <FiVideoOff size={24} /> : <FiVideo size={24} />}
                </button>
              )}

              {/* Loudspeaker Toggle */}
              <button onClick={handleToggleSpeaker} className={`w-12 h-12 rounded-full ${isSpeakerphone ? 'bg-white/10' : 'bg-accent'} hover:bg-white/20 text-white flex items-center justify-center transition-all backdrop-blur-md`}>
                {isSpeakerphone ? <FiVolume2 size={20} /> : <FiVolumeX size={20} />}
              </button>

              <button 
                onClick={(e) => { e.stopPropagation(); hangup(); }}
                className="w-14 h-14 rounded-full bg-red-500 text-white hover:bg-red-600 flex items-center justify-center transition-all shadow-[0_0_20px_rgba(239,68,68,0.4)]"
              >
                <FiPhoneOff size={24} />
              </button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
