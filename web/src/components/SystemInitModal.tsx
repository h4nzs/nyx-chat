import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiCheckCircle, FiXCircle, FiLoader, FiShield, FiBell, FiCamera } from 'react-icons/fi';

type PermStatus = 'idle' | 'loading' | 'granted' | 'denied';

export default function SystemInitModal() {
  const [isVisible, setIsVisible] = useState(false);
  const [notifStatus, setNotifStatus] = useState<PermStatus>('idle');
  const [mediaStatus, setMediaStatus] = useState<PermStatus>('idle');

  useEffect(() => {
    const hasInit = localStorage.getItem('nyx_sys_init');
    if (!hasInit) setIsVisible(true);
  }, []);

  const close = () => {
    localStorage.setItem('nyx_sys_init', 'true');
    setIsVisible(false);
  };

  const requestPermissions = async () => {
    // 1. Request Notifications
    setNotifStatus('loading');
    try {
      const nPerm = await Notification.requestPermission();
      setNotifStatus(nPerm === 'granted' ? 'granted' : 'denied');
    } catch (e) {
      setNotifStatus('denied');
    }

    // 2. Request Camera & Mic
    setMediaStatus('loading');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      // IMPORTANT: Stop tracks immediately. We only want the permission.
      stream.getTracks().forEach(track => track.stop());
      setMediaStatus('granted');
    } catch (e) {
      setMediaStatus('denied');
    }

    // Give user 1.5s to see the final status, then close
    setTimeout(close, 1500);
  };

  if (!isVisible) return null;

  const renderIcon = (status: PermStatus) => {
    if (status === 'loading') return <FiLoader className="animate-spin text-accent" />;
    if (status === 'granted') return <FiCheckCircle className="text-green-500" />;
    if (status === 'denied') return <FiXCircle className="text-red-500" />;
    return <div className="w-4 h-4 rounded-full border-2 border-text-secondary/50" />;
  };

  return (
    <AnimatePresence>
      <motion.div 
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-[99999] bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
      >
        <motion.div 
          initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }}
          className="bg-bg-surface border border-white/10 rounded-2xl p-8 max-w-md w-full shadow-2xl relative overflow-hidden"
        >
          {/* Hacker-y background lines */}
          <div className="absolute top-0 left-0 w-full h-1 bg-[repeating-linear-gradient(90deg,transparent,transparent_10px,#4f46e5_10px,#4f46e5_20px)] opacity-50"></div>
          
          <div className="flex items-center gap-3 mb-6 text-accent">
             <FiShield size={28} />
             <h2 className="text-2xl font-black uppercase tracking-widest">System Init</h2>
          </div>

          <p className="text-text-secondary text-sm mb-8 leading-relaxed">
            To enable End-to-End Encrypted Voice/Video calls and real-time alerts, NYX requires hardware access. Your media never leaves your device unencrypted.
          </p>

          <div className="space-y-4 mb-8 font-mono text-sm">
            <div className="flex items-center justify-between p-3 rounded-lg bg-bg-main border border-white/5">
               <div className="flex items-center gap-3">
                 <FiBell className="text-text-primary" />
                 <span>Push Notifications</span>
               </div>
               {renderIcon(notifStatus)}
            </div>
            
            <div className="flex items-center justify-between p-3 rounded-lg bg-bg-main border border-white/5">
               <div className="flex items-center gap-3">
                 <FiCamera className="text-text-primary" />
                 <span>Camera & Microphone</span>
               </div>
               {renderIcon(mediaStatus)}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <button 
              onClick={requestPermissions}
              disabled={notifStatus === 'loading' || mediaStatus === 'loading'}
              className="w-full py-3 rounded-xl bg-accent text-white font-bold uppercase tracking-wider hover:bg-indigo-600 transition-colors disabled:opacity-50"
            >
              {notifStatus === 'loading' || mediaStatus === 'loading' ? 'Calibrating...' : 'Authorize Systems'}
            </button>
            <button 
              onClick={close}
              className="w-full py-3 rounded-xl text-text-secondary font-bold text-sm uppercase tracking-wider hover:text-text-primary transition-colors"
            >
              Skip for now
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}