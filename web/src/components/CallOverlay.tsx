import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiPhone, FiVideo, FiVideoOff, FiMic, FiMicOff, FiPhoneOff, FiMinimize2, FiMaximize2, FiRefreshCw, FiWifi, FiVolume2, FiVolumeX, FiMonitor } from 'react-icons/fi';
import { useCallStore } from '../store/callStore';
import { acceptCall, rejectCall, hangup, replaceVideoTrack, getNetworkQuality } from '../lib/webrtc';
import { toAbsoluteUrl } from '../utils/url';
import toast from 'react-hot-toast';
import type { UserId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

const RemoteStream = ({ userId, stream, isVideo, profile }: { userId: UserId, stream?: MediaStream, isVideo: boolean, profile: Record<string, unknown> }) => {
  const { t } = useTranslation(['common']);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (stream) {
      if (isVideo && videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      if (!isVideo && audioRef.current) {
        audioRef.current.srcObject = stream;
      }
    }
  }, [stream, isVideo]);

  const name = (profile?.name as string) || t('defaults.user', 'User');
  const avatar = toAbsoluteUrl(profile?.avatarUrl as string) || `https://api.dicebear.com/8.x/initials/svg?seed=${name}`;

  return (
    <div className="relative w-full h-full bg-gray-900 rounded-2xl overflow-hidden shadow-xl border border-white/10 group flex items-center justify-center">
      {isVideo ? (
        <>
          <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
          {!stream && (
             <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                <FiRefreshCw size={24} className="animate-spin text-white/50" />
             </div>
          )}
        </>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center bg-bg-surface">
           <audio ref={audioRef} autoPlay />
           <div className="relative">
              <img src={avatar} alt={name} className="w-20 h-20 rounded-full object-cover mb-2 border-2 border-accent/30 shadow-lg" />
              {stream && (
                <div className="absolute -bottom-1 -right-1 bg-green-500 w-4 h-4 rounded-full border-2 border-bg-surface shadow-sm"></div>
              )}
           </div>
           <span className="text-xs font-bold text-white/70 uppercase tracking-widest">{name}</span>
        </div>
      )}
      <div className="absolute bottom-3 left-3 px-2 py-1 bg-black/60 backdrop-blur-md rounded-lg text-[9px] text-white/90 font-black uppercase tracking-tighter border border-white/10">
        {name}
      </div>
    </div>
  );
};

export default function CallOverlay() {
  const { t } = useTranslation(['chat', 'common']);
  const { 
    callState, 
    remoteUsers,
    remoteStreams, 
    isVideoCall, 
    isReceivingCall,
    localStream,
    isMinimized,
    toggleMinimize
  } = useCallStore();

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);

  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [networkQuality, setNetworkQuality] = useState<'Good' | 'Fair' | 'Poor'>('Good');
  const [isSpeakerphone, setIsSpeakerphone] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const originalVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);

  const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent);

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
      
      // CRITICAL FIX FOR MOBILE: Stop existing camera before requesting the new one
      const oldStream = localVideoRef.current?.srcObject as MediaStream;
      if (oldStream) {
        oldStream.getVideoTracks().forEach(t => t.stop());
      }

      // Request new camera
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: newMode } });
      const newVideoTrack = newStream.getVideoTracks()[0];

      // Call WebRTC helper to send the new track to the peer
      await replaceVideoTrack(newVideoTrack);

      // Update local video element.
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = new MediaStream([newVideoTrack]);
      }
      setFacingMode(newMode);
    } catch (err) {
      console.error("Camera switch failed:", err);
      toast.error(t('chat:calls.camera_switch_failed'));
    }
  };

  const handleToggleSpeaker = async (e: React.MouseEvent) => {
    e.stopPropagation();
    toast(t('chat:calls.speaker_restricted'), { icon: '📱' });
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
            localVideoRef.current.srcObject = new MediaStream([originalVideoTrackRef.current]);
          }
        }
        setIsScreenSharing(false);
        toast.success(t('chat:calls.screen_share_stopped'));

      } else {
        // --- START SCREEN SHARING ---
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = displayStream.getVideoTracks()[0];
        screenTrackRef.current = screenTrack;

        // Save the current camera track WITHOUT stopping or cloning it
        if (localVideoRef.current) {
            const currentStream = localVideoRef.current.srcObject as MediaStream;
            if (currentStream && currentStream.getVideoTracks().length > 0) {
                originalVideoTrackRef.current = currentStream.getVideoTracks()[0];
            }
        }

        // Send screen track to peer
        await replaceVideoTrack(screenTrack);

        // Show screen track on local preview
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = new MediaStream([screenTrack]);
        }

        setIsScreenSharing(true);
        toast.success(t('chat:calls.screen_share_started'));

        // Handle native browser "Stop Sharing" button
        screenTrack.onended = async () => {
            setIsScreenSharing(false);
            screenTrackRef.current = null;
            if (originalVideoTrackRef.current) {
                await replaceVideoTrack(originalVideoTrackRef.current);
                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = new MediaStream([originalVideoTrackRef.current]);
                }
            }
        };
      }
    } catch (err) {
      console.error("Screen share error:", err);
      toast.error(t('chat:calls.screen_share_failed'));
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

  const mainRemoteUser = remoteUsers[0] || { id: 'unknown', name: t('common:defaults.someone', 'Someone') };
  const profileName = remoteUsers.length > 1 ? `Group (${remoteUsers.length})` : (mainRemoteUser.name || t('common:defaults.someone', 'Someone'));
  const profileAvatar = toAbsoluteUrl(mainRemoteUser.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profileName}`;

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
            
            <h3 className="text-xl font-bold text-text-primary mb-1 tracking-tight">{profileName}</h3>
            <p className="text-text-secondary mb-8 text-sm uppercase font-black tracking-widest opacity-60">
              {isVideoCall ? t('chat:calls.incoming_video') : t('chat:calls.incoming_voice')}
            </p>

            <div className="flex gap-6">
              <button 
                onClick={rejectCall}
                aria-label={t('chat:calls.actions.reject')}
                className="w-14 h-14 rounded-full bg-red-500/20 text-red-500 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all shadow-lg hover:shadow-red-500/50"
              >
                <FiPhoneOff size={24} />
              </button>
              <button 
                onClick={acceptCall}
                aria-label={isVideoCall ? t('chat:calls.actions.accept_video') : t('chat:calls.actions.accept_voice')}
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
          // Animate x and y back to 0 when full-screen to prevent off-center maximization
          animate={{ opacity: 1, x: isMinimized ? undefined : 0, y: isMinimized ? undefined : 0 }} 
          exit={{ opacity: 0 }}
          drag={isMinimized}
          dragMomentum={false}
          onDragStart={() => setIsDragging(true)}
          onDragEnd={() => {
            // Small delay to prevent onClick from firing immediately after dropping
            setTimeout(() => setIsDragging(false), 150);
          }}
          onClick={(e) => { 
            if (isDragging) {
              e.stopPropagation();
              return;
            }
            if (isMinimized) toggleMinimize(); 
          }}
          style={isMinimized ? { touchAction: "none" } : {}}
          className={
            isMinimized 
            ? "fixed bottom-20 right-4 w-28 h-40 sm:w-48 sm:h-72 z-[9999] bg-bg-main/90 backdrop-blur-md rounded-2xl shadow-2xl overflow-hidden cursor-grab active:cursor-grabbing border border-white/10 group"
            : "fixed inset-0 z-[9999] bg-black flex flex-col overflow-hidden transition-all duration-300 cursor-default"
          }
        >
          {!isMinimized && (
            <button 
              onClick={(e) => { e.stopPropagation(); toggleMinimize(); }} 
              className="p-3 bg-white/10 hover:bg-white/20 rounded-full backdrop-blur-md transition-all text-white absolute top-6 left-6 z-50"
              title={t('chat:calls.actions.minimize')}
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
            <div className={`absolute top-6 right-20 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-tighter flex items-center gap-2 shadow-lg backdrop-blur-md transition-colors ${networkQuality === 'Poor' ? 'bg-red-500/80' : networkQuality === 'Fair' ? 'bg-yellow-500/80' : 'bg-green-500/80'} text-white z-50`}>
              <FiWifi /> {networkQuality}
            </div>
          )}

          <div className="flex-1 relative flex items-center justify-center w-full h-full p-4 overflow-auto">
            {callState === 'calling' && !isMinimized && (
               <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center z-10">
                  <div className="w-32 h-32 rounded-full overflow-hidden border-4 border-accent animate-pulse shadow-2xl mb-6">
                    <img src={profileAvatar} alt={profileName} className="w-full h-full object-cover" />
                  </div>
                  <h2 className="text-2xl font-black text-white uppercase tracking-widest">{profileName}</h2>
                  <p className="text-accent font-mono text-xs mt-2 animate-bounce">{t('chat:calls.dialing')}</p>
               </div>
            )}

            {callState === 'connected' && (
              <div className={`
                grid gap-4 w-full h-full max-w-6xl mx-auto
                ${isMinimized ? 'grid-cols-1' : 
                  remoteUsers.length <= 1 ? 'grid-cols-1' : 
                  remoteUsers.length <= 2 ? 'grid-cols-1 md:grid-cols-2' : 
                  'grid-cols-2 md:grid-cols-3'}
              `}>
                {remoteUsers.map(user => (
                  <RemoteStream 
                    key={user.id} 
                    userId={user.id} 
                    stream={remoteStreams[user.id]} 
                    isVideo={isVideoCall} 
                    profile={user} 
                  />
                ))}
              </div>
            )}
            
            {/* Local Preview (Floating) */}
            {!isMinimized && isVideoCall && (
              <div className="absolute bottom-24 right-6 w-32 h-48 md:w-48 md:h-72 bg-gray-900 rounded-2xl overflow-hidden shadow-2xl border border-white/20 z-30">
                <video 
                  ref={localVideoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className="w-full h-full object-cover"
                />
                <div className="absolute bottom-2 left-2 px-1.5 py-0.5 bg-black/40 backdrop-blur-md rounded text-[8px] text-white/80 font-bold uppercase">{t('common:defaults.you', 'YOU')}</div>
              </div>
            )}

            {!isMinimized && !isVideoCall && (
               <div className="absolute bottom-24 right-6 w-20 h-20 bg-accent/20 rounded-full overflow-hidden border-2 border-accent/50 z-30 flex items-center justify-center backdrop-blur-md">
                  <FiMic size={24} className="text-accent animate-pulse" />
               </div>
            )}
            
            {/* Overlay Gradient for controls */}
            {!isMinimized && (
               <div className="absolute bottom-0 left-0 right-0 h-40 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />
            )}
          </div>

          {!isMinimized && (
            <div className="absolute bottom-0 left-0 right-0 p-8 flex justify-center gap-4 sm:gap-6 z-40">
              {/* Flip Camera (Only if Video Call) */}
              {isVideoCall && (
                <button 
                  onClick={handleFlipCamera} 
                  aria-label={t('chat:calls.actions.flip_camera')}
                  className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all backdrop-blur-md border border-white/5"
                >
                  <FiRefreshCw size={20} />
                </button>
              )}
              
              {/* Screen Share Toggle (Only for Video Calls & Non-Mobile) */}
              {isVideoCall && !isMobile && (
                <button 
                  onClick={handleToggleScreenShare} 
                  aria-label={isScreenSharing ? t('chat:calls.actions.stop_sharing') : t('chat:calls.actions.share_screen')}
                  className={`w-12 h-12 rounded-full ${isScreenSharing ? 'bg-blue-500' : 'bg-white/10 hover:bg-white/20'} text-white flex items-center justify-center transition-all backdrop-blur-md border border-white/5`}
                  title={isScreenSharing ? t('chat:calls.actions.stop_sharing') : t('chat:calls.actions.share_screen')}
                >
                  <FiMonitor size={20} />
                </button>
              )}

              <button 
                onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                aria-label={isMuted ? t('chat:calls.actions.unmute') : t('chat:calls.actions.mute')}
                className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${isMuted ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'} backdrop-blur-md border border-white/10`}
              >
                {isMuted ? <FiMicOff size={24} /> : <FiMic size={24} />}
              </button>
              
              {isVideoCall && (
                <button 
                  onClick={(e) => { e.stopPropagation(); toggleVideo(); }}
                  aria-label={isVideoOff ? t('chat:calls.actions.video_on') : t('chat:calls.actions.video_off')}
                  className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${isVideoOff ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'} backdrop-blur-md border border-white/10`}
                >
                  {isVideoOff ? <FiVideoOff size={24} /> : <FiVideo size={24} />}
                </button>
              )}

              {/* Loudspeaker Toggle */}
              <button 
                onClick={handleToggleSpeaker} 
                aria-label={isSpeakerphone ? t('chat:calls.actions.earpiece') : t('chat:calls.actions.speaker')}
                className={`w-12 h-12 rounded-full ${isSpeakerphone ? 'bg-white/10' : 'bg-accent'} hover:bg-white/20 text-white flex items-center justify-center transition-all backdrop-blur-md border border-white/5`}
              >
                {isSpeakerphone ? <FiVolume2 size={20} /> : <FiVolumeX size={20} />}
              </button>

              <button 
                onClick={(e) => { e.stopPropagation(); hangup(); }}
                aria-label={t('chat:calls.actions.end')}
                className="w-14 h-14 rounded-full bg-red-500 text-white hover:bg-red-600 flex items-center justify-center transition-all shadow-[0_0_30px_rgba(239,68,68,0.6)] border border-red-400/20"
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
