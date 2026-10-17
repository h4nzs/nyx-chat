import { useEffect, useRef, useState } from 'react';
import { FiX, FiCamera } from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
// Type-only import: tidak ikut ke bundle (html5-qrcode di-load lazy di runtime)
import type { Html5Qrcode } from 'html5-qrcode';
import { parseProfileShareLink } from '@utils/usernameLink';

interface Props {
  onClose: () => void;
  /** Query string siap tempel ke `/connect` (mis. `?u=<hashId>`). */
  onScanSuccess: (connectQuery: string) => void;
}

export default function ScanQRModal({ onClose, onScanSuccess }: Props) {
  const { t } = useTranslation(['modals']);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let localScanner: Html5Qrcode | null = null;

    const timer = setTimeout(async () => {
      // Lazy import: html5-qrcode hanya diunduh saat user benar-benar membuka scanner
      const { Html5Qrcode } = await import('html5-qrcode');
      if (cancelled) return;

      localScanner = new Html5Qrcode('nyx-qr-reader');
      scannerRef.current = localScanner;
      localScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          // [docs/30 §30.13 WS-I] Satu parser untuk kedua bentuk tautan berbagi:
          //   - `/u/<hashId>` (link pendek WS-I, hanya memuat hashId);
          //   - `/connect?u=…&i=…&p=…` (QR lama yang sudah beredar — termasuk
          //     `i`/`p` — tetap diterima apa adanya).
          // Memakai parser yang sama dengan halaman `/u/:hashId` membuat aturan
          // bentuk hashId tidak bercabang: segmen tak sah tidak pernah jadi
          // request pencarian, dan QR non-NYX diabaikan tanpa menghentikan kamera.
          const connectQuery = parseProfileShareLink(decodedText);
          if (!connectQuery) return; // bukan tautan berbagi NYX — lanjut memindai
          if (scannerRef.current) {
            await scannerRef.current.stop();
          }
          onScanSuccess(connectQuery);
        },
        () => {} // Ignore scan failures (frame missed)
      ).catch(err => {
          if (cancelled) return;
          console.error("Camera start failed", err);
          setError(t('scan.camera_error'));
      });
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (localScanner?.isScanning) {
        localScanner.stop().catch(() => {});
        localScanner.clear();
      }
    };
  }, [onScanSuccess, t]);

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
          className="bg-bg-surface border border-text-secondary/10 rounded-3xl p-6 max-w-sm w-full shadow-2xl relative overflow-hidden"
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
            <h2 className="text-xl font-black uppercase tracking-widest text-text-primary">{t('scan.title')}</h2>
            <p className="text-xs text-text-secondary mt-1 font-mono">{t('scan.desc')}</p>
          </div>

          <div className="w-full aspect-square bg-black rounded-2xl overflow-hidden relative shadow-inner border-2 border-text-secondary/10">
             {error ? (
               <div className="absolute inset-0 flex items-center justify-center text-red-500 text-sm text-center p-4">
                 {error}
               </div>
             ) : (
               <div id="nyx-qr-reader" className="w-full h-full" />
             )}
          </div>
          
          <div className="mt-6 text-center">
            <p className="text-[10px] text-text-secondary uppercase tracking-widest">{t('scan.awaiting')}</p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
