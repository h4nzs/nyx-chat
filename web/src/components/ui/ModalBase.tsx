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
    y: "-50px",
    opacity: 0,
    scale: 0.95,
  },
  visible: {
    y: "0",
    opacity: 1,
    scale: 1,
    transition: {
      duration: 0.2,
      type: "spring",
      damping: 25,
      stiffness: 500,
    },
  },
  exit: {
    y: "50px",
    opacity: 0,
    scale: 0.95,
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
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" aria-hidden="true" />
          <motion.div
            variants={dropIn}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            className="relative w-full max-w-md bg-bg-surface rounded-xl shadow-neumorphic-convex flex flex-col max-h-[90vh]"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4">
              <h2 id="modal-title" className="text-lg font-semibold text-text-primary">{title}</h2>
              <button
                onClick={onClose}
                aria-label="Close modal"
                className="touch-target p-2 rounded-full text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all"
              >
                <FiX size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 overflow-y-auto flex-grow">
              {children}
            </div>

            {/* Footer */}
            {footer && (
              <div className="flex justify-end gap-3 p-4 bg-bg-surface rounded-b-xl">
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
