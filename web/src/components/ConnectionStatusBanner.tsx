import { useConnectionStore } from '@store/connection';
import { Spinner } from './Spinner';
import { motion, AnimatePresence } from 'framer-motion';
import { FiZap, FiAlertTriangle } from 'react-icons/fi';

export default function ConnectionStatusBanner() {
  const { status } = useConnectionStore();

  const isVisible = status === 'connecting' || status === 'disconnected';

  const config = status === 'disconnected' 
    ? {
        message: 'CONNECTION_LOST // SYSTEM_OFFLINE',
        bg: 'bg-red-500',
        stripeColor: '#991b1b', // Red-800
        text: 'text-white',
        showDonate: true
      }
    : {
        message: 'ESTABLISHING_UPLINK...',
        bg: 'bg-yellow-500',
        stripeColor: '#a16207', // Yellow-700
        text: 'text-black',
        showDonate: false
      };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ y: "-100%" }}
          animate={{ y: "0%" }}
          exit={{ y: "-100%" }}
          transition={{ type: "spring", stiffness: 120, damping: 20, mass: 1.5 }}
          className={`
            fixed top-0 left-0 w-full z-[100]
            ${config.bg} ${config.text}
            border-b-4 border-black/20
            shadow-[0_10px_30px_rgba(0,0,0,0.5)]
          `}
        >
          {/* Hazard Stripes Pattern */}
          <div 
            className="absolute inset-0 opacity-20 pointer-events-none"
            style={{
              backgroundImage: `repeating-linear-gradient(
                -45deg,
                transparent,
                transparent 10px,
                ${config.stripeColor} 10px,
                ${config.stripeColor} 20px
              )`
            }}
          />

          <div className="relative flex flex-col sm:flex-row items-center justify-center gap-4 py-3 px-4">
            <div className="flex items-center gap-3">
              {status === 'disconnected' ? (
                <FiAlertTriangle className="animate-pulse" size={20} />
              ) : (
                <Spinner size="sm" className={config.text} />
              )}
              <span className="font-mono text-xs font-black tracking-widest uppercase">
                {config.message}
              </span>
            </div>

            {config.showDonate && (
              <a
                href="https://sociabuzz.com/h4nzs/tribe"
                target="_blank"
                rel="noopener noreferrer"
                className="
                  flex items-center gap-2 px-4 py-1.5 rounded-md
                  bg-black/20 hover:bg-black/30 
                  border border-black/10
                  transition-all active:scale-95
                  text-[10px] font-bold font-mono uppercase tracking-wide
                "
              >
                <FiZap size={12} className="text-yellow-300 animate-pulse" />
                <span>Power Surge Required</span>
              </a>
            )}
          </div>
          
          {/* Mechanical Lip */}
          <div className="h-1 bg-black/30 w-full"></div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}