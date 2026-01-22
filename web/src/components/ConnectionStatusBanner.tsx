import { useConnectionStore } from '@store/connection';
import { Spinner } from './Spinner';
import { motion, AnimatePresence } from 'framer-motion';
import { FiZap } from 'react-icons/fi';

export default function ConnectionStatusBanner() {
  const { status } = useConnectionStore();

  const isVisible = status === 'connecting' || status === 'disconnected';

  // Konfigurasi tampilan berdasarkan status
  const config = status === 'disconnected' 
    ? {
        message: 'Connection lost. Reconnecting...',
        bg: 'bg-red-500/95',
        text: 'text-white',
        spinnerColor: 'text-white',
        showDonate: true
      }
    : {
        message: 'Connecting...',
        bg: 'bg-yellow-500/90',
        text: 'text-black',
        spinnerColor: 'text-black',
        showDonate: false
      };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ y: -60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -60, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className={`
            fixed top-0 left-0 w-full z-50 
            ${config.bg} backdrop-blur-md ${config.text}
            p-2 sm:py-3 text-sm font-semibold 
            shadow-lg rounded-b-2xl
            flex flex-wrap items-center justify-center gap-2 sm:gap-6
          `}
        >
          {/* Status Message */}
          <div className="flex items-center gap-2">
            <Spinner size="sm" className={config.spinnerColor} />
            <span>{config.message}</span>
          </div>

          {/* Tombol Donasi (Hanya muncul saat disconnect) */}
          {config.showDonate && (
            <a
              href="https://sociabuzz.com/h4nzs/tribe" // Pastikan username ini benar
              target="_blank"
              rel="noopener noreferrer"
              className="
                flex items-center gap-1.5 px-3 py-1 rounded-full
                bg-white/20 border border-white/30
                hover:bg-white/30 transition-all active:scale-95
                text-xs font-bold
              "
            >
              <FiZap size={12} className="animate-pulse" />
              <span>Server suck? Support Us</span>
            </a>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}