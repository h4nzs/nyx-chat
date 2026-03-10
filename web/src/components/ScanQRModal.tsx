import { useEffect, useRef, useState } from 'react';
import { FiX, FiCamera } from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import { Html5Qrcode } from 'html5-qrcode';
import toast from 'react-hot-toast';

interface Props {
  onClose: () => void;
  onScanSuccess: (hash: string) => void;
}

export default function ScanQRModal({ onClose, onScanSuccess }: Props) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      scannerRef.current = new Html5Qrcode('nyx-qr-reader');
      scannerRef.current.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          try {
            // Looking for .../connect?u=HASH
            const url = new URL(decodedText);
            const u = url.searchParams.get('u');
            if (u && u.length > 10) {
              if (scannerRef.current) {
                await scannerRef.current.stop();
              }
              onScanSuccess(u);
            } else {
              // Not a valid connect link but keep scanning
            }
          } catch (e) {
            // Not a valid URL, ignore
          }
        },
        () => {} // Ignore scan failures (frame missed)
      ).catch(err => {
          console.error("Camera start failed", err);
          setError("Camera access denied or unavailable.");
      });
    }, 200);

    return () => {
      clearTimeout(timer);
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch(() => {});
      }
    };
  }, [onScanSuccess]);

  return (
    <AnimatePresence>
      <motion.div 
        initial={{ opacity: 0 }} 
        animate={{ opacity: 1 }} 
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div 
          initial={{ scale: 0.95, y: 20 }} 
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 20 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-bg-surface border border-white/10 rounded-3xl p-6 max-w-sm w-full shadow-2xl relative overflow-hidden"
        >
          <button 
            onClick={onClose}
            className="absolute top-4 right-4 z-10 p-2 text-white/50 hover:text-white bg-black/40 rounded-full transition-colors"
          >
            <FiX size={20} />
          </button>

          <div className="text-center mb-6">
            <div className="w-12 h-12 rounded-full bg-accent/20 text-accent flex items-center justify-center mx-auto mb-3">
              <FiCamera size={24} />
            </div>
            <h2 className="text-xl font-black uppercase tracking-widest text-text-primary">Scan Contact</h2>
            <p className="text-xs text-text-secondary mt-1 font-mono">Scan a NYX QR code</p>
          </div>

          <div className="w-full aspect-square bg-black rounded-2xl overflow-hidden relative shadow-inner border-2 border-white/5">
             {error ? (
               <div className="absolute inset-0 flex items-center justify-center text-red-500 text-sm text-center p-4">
                 {error}
               </div>
             ) : (
               <div id="nyx-qr-reader" className="w-full h-full" />
             )}
          </div>
          
          <div className="mt-6 text-center">
            <p className="text-[10px] text-text-secondary uppercase tracking-widest">Awaiting target...</p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
