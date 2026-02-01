import { motion, AnimatePresence, Variants } from 'framer-motion';
import { FiX } from 'react-icons/fi';
import React from 'react';
import { useGlobalEscape } from '../../hooks/useGlobalEscape';

interface ModalBaseProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

const dropIn: Variants = {
  hidden: {
    y: "20px",
    opacity: 0,
    scale: 0.98,
  },
  visible: {
    y: "0",
    opacity: 1,
    scale: 1,
    transition: {
      duration: 0.3,
      ease: [0.23, 1, 0.32, 1], // Cubic bezier for mechanical feel
    },
  },
  exit: {
    y: "20px",
    opacity: 0,
    scale: 0.98,
    transition: {
      duration: 0.2,
    },
  },
};

const ModalBase: React.FC<ModalBaseProps> = ({ isOpen, onClose, title, children, footer }) => {
  useGlobalEscape(onClose);

  return (
    <AnimatePresence>
      {isOpen && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onMouseDown={onClose}
        >
          {/* Backdrop */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-md" 
            aria-hidden="true" 
          />
          
          <motion.div
            variants={dropIn}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            className="
              relative w-full max-w-md 
              bg-bg-main 
              rounded-2xl 
              shadow-neu-flat-light dark:shadow-neu-flat-dark
              border border-white/20 dark:border-black/20
              flex flex-col max-h-[90vh] overflow-hidden
            "
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Mechanical Header */}
            <div className="
              flex items-center justify-between px-6 py-4 
              border-b border-black/5 dark:border-white/5
              bg-bg-main
            ">
              <div className="flex items-center gap-3">
                <div className="w-1.5 h-4 bg-accent rounded-full shadow-[0_0_8px_rgba(var(--accent),0.6)]"></div>
                <h2 id="modal-title" className="text-sm font-black uppercase tracking-widest text-text-primary">
                  {title}
                </h2>
              </div>
              <button
                onClick={onClose}
                aria-label="Close modal"
                className="
                  group
                  p-2 rounded-full 
                  text-text-secondary 
                  shadow-neu-flat dark:shadow-neu-flat-dark
                  active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark
                  hover:text-red-500
                  transition-all duration-200
                "
              >
                <FiX size={18} className="group-hover:rotate-90 transition-transform duration-200" />
              </button>
            </div>

            {/* Content Well */}
            <div className="p-6 overflow-y-auto flex-grow scrollbar-hide">
              {children}
            </div>

            {/* Footer Control Deck */}
            {footer && (
              <div className="
                flex justify-end gap-4 px-6 py-4 
                bg-bg-main 
                border-t border-black/5 dark:border-white/5
              ">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default ModalBase;
