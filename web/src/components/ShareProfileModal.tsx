import { FiX, FiCopy, FiCheck } from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import * as QRCodeModule from 'react-qr-code';
import { useAuthStore } from '@store/auth';
import { useUserProfile } from '@hooks/useUserProfile';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

const QRCode = QRCodeModule.default || QRCodeModule;

interface Props {
  onClose: () => void;
}

export default function ShareProfileModal({ onClose }: Props) {
  const { t } = useTranslation(['modals', 'common']);
  const user = useAuthStore(state => state.user);
  const profile = useUserProfile(user);
  const [copied, setCopied] = useState(false);

  if (!user?.usernameHash) {
    return null; // Should not happen if data is loaded
  }

  const shareUrl = `${window.location.origin}/connect?u=${user.usernameHash}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success(t('common:actions.copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('common:actions.copy_failed'));
    }
  };

  return (
    <AnimatePresence>
      <motion.div 
        initial={{ opacity: 0 }} 
        animate={{ opacity: 1 }} 
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div 
          initial={{ scale: 0.95, y: 20 }} 
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 20 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-bg-surface border border-white/10 rounded-2xl p-6 max-w-sm w-full shadow-2xl relative"
        >
          <button 
            onClick={onClose}
            className="absolute top-4 right-4 p-2 text-text-secondary hover:text-white bg-black/20 rounded-full hover:bg-black/40 transition-colors"
          >
            <FiX size={20} />
          </button>

          <div className="text-center mb-6 mt-2">
            <h2 className="text-xl font-black uppercase tracking-widest text-text-primary">{t('modals:share.title')}</h2>
            <p className="text-xs text-text-secondary mt-1 font-mono">{t('modals:share.desc')}</p>
          </div>

          <div className="bg-white p-4 rounded-xl flex items-center justify-center mx-auto w-fit mb-6 shadow-neumorphic-pressed">
            <QRCode value={shareUrl} size={200} level="M" />
          </div>

          <div className="text-center mb-6 flex flex-col items-center">
            <div className="w-16 h-16 rounded-full overflow-hidden shadow-neu-flat-light dark:shadow-neu-flat-dark border-2 border-accent mb-3">
              <img 
                src={profile?.avatarUrl || `https://api.dicebear.com/8.x/initials/svg?seed=${profile?.name || 'Anonymous'}`} 
                alt="Avatar" 
                className="w-full h-full object-cover"
              />
            </div>
            <h3 className="font-bold text-lg text-text-primary">{profile?.name || t('common:defaults.encrypted_user')}</h3>
          </div>

          <button 
            onClick={handleCopy}
            className="w-full py-3 rounded-xl bg-bg-main border border-white/5 text-text-primary font-bold uppercase tracking-wider hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
          >
            {copied ? <FiCheck className="text-green-500" /> : <FiCopy />}
            {copied ? t('common:actions.copied_label') : t('common:actions.copy_link')}
          </button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
