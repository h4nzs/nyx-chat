import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiShield } from 'react-icons/fi';

export default function PrivacyCloak() {
  const [isCloaked, setIsCloaked] = useState(false);

  useEffect(() => {
    // Handler for tab visibility (switching tabs, minimizing browser)
    const handleVisibilityChange = () => {
      if (document.hidden || document.visibilityState === 'hidden') {
        setIsCloaked(true);
      } else {
        setIsCloaked(false);
      }
    };

    // Handler for window focus loss (opening Task Manager, clicking outside window)
    const handleBlur = () => setIsCloaked(true);
    const handleFocus = () => {
      // Double check visibility before uncloaking on focus
      if (!document.hidden) {
        setIsCloaked(false);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    // Initial check
    if (document.hidden) setIsCloaked(true);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  return (
    <AnimatePresence>
      {isCloaked && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.1 }} // Ultra-fast transition to beat the OS screenshot mechanism
          className="fixed inset-0 z-[999999] bg-bg-main flex flex-col items-center justify-center backdrop-blur-xl"
          style={{ 
            // Ensures it covers literally everything, ignoring normal layout flows
            pointerEvents: 'none', 
            overscrollBehavior: 'none' 
          }}
        >
          {/* Subtle hacker pattern background */}
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none"></div>

          <motion.div 
            initial={{ scale: 0.9, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="flex flex-col items-center gap-6 relative z-10"
          >
            <div className="w-24 h-24 rounded-full bg-bg-surface border border-white/10 shadow-2xl flex items-center justify-center text-accent">
              <FiShield size={48} className="animate-pulse" />
            </div>
            
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-black tracking-widest uppercase text-text-primary drop-shadow-md">NYX</h1>
              <p className="text-sm font-mono text-text-secondary uppercase tracking-widest flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-accent animate-ping"></span>
                Secure Context Locked
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}