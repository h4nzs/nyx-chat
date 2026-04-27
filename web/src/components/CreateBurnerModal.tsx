import { FiX, FiCopy, FiCheck, FiZap } from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

interface Props {
  onClose: () => void;
}

export default function CreateBurnerModal({ onClose }: Props) {
  const { t } = useTranslation(['modals', 'common']);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(true);

  useEffect(() => {
    let mounted = true;
    const generate = async () => {
      try {
        const { generateBurnerLink } = await import('@store/burner');
        const generatedLink = await generateBurnerLink();
        if (mounted) {
          setLink(generatedLink);
          setIsGenerating(false);
        }
      } catch (e) {
        console.error(e);
        if (mounted) {
          setError('Failed to generate secure burner link.');
          setIsGenerating(false);
        }
      }
    };
    generate();
    return () => { mounted = false; };
  }, []);

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success('Burner Chat link copied!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy link');
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
            <div className="mx-auto w-12 h-12 rounded-full bg-accent/20 text-accent flex items-center justify-center mb-4">
              <FiZap size={24} />
            </div>
            <h2 className="text-xl font-black uppercase tracking-widest text-text-primary">Burner Chat</h2>
            <p className="text-xs text-text-secondary mt-2 font-mono leading-relaxed">
              Generate a one-time, post-quantum encrypted ephemeral chat link. Data exists only in RAM.
            </p>
          </div>

          <div className="bg-bg-main p-4 rounded-xl flex items-center justify-center mx-auto w-full mb-6 border border-border">
            {isGenerating ? (
              <div className="flex items-center gap-3 text-text-secondary">
                 <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
                 <span className="text-sm font-mono">Provisioning keys...</span>
              </div>
            ) : error ? (
              <span className="text-sm font-mono text-red-500">{error}</span>
            ) : (
              <div className="w-full relative">
                 <div className="text-xs font-mono text-text-secondary break-all truncate overflow-hidden whitespace-nowrap opacity-60 px-2">
                    {link}
                 </div>
              </div>
            )}
          </div>

          <button 
            onClick={handleCopy}
            disabled={isGenerating || !!error}
            className="w-full py-3 rounded-xl bg-accent text-white font-bold uppercase tracking-wider hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 shadow-neu-flat-light dark:shadow-neu-flat-dark"
          >
            {copied ? <FiCheck className="text-white" /> : <FiCopy />}
            {copied ? 'Copied to Clipboard' : 'Copy Secure Link'}
          </button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}