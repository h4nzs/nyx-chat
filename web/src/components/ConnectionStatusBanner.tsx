import { useConnectionStore } from '@store/connection';
import { Spinner } from './Spinner';
import { motion, AnimatePresence } from 'framer-motion';

export default function ConnectionStatusBanner() {
  const { status } = useConnectionStore();

  const isVisible = status === 'connecting' || status === 'disconnected';

  let message = '';
  if (status === 'connecting') {
    message = 'Connecting...';
  } else if (status === 'disconnected') {
    message = 'Connection lost. Reconnecting...';
  }

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="fixed top-0 left-0 w-full bg-yellow-500/90 backdrop-blur-sm text-black font-semibold text-center p-3 text-sm z-50 flex items-center justify-center gap-2 shadow-lg rounded-b-2xl"
        >
          <Spinner size="sm" />
          <span>{message}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}