
import { useState, useEffect } from 'react';
import QRCode from 'react-qr-code';
import { FiShield, FiX, FiCheck } from 'react-icons/fi';
import { Spinner } from './Spinner';

interface SafetyNumberModalProps {
  safetyNumber: string;
  userName: string;
  onClose: () => void;
  onVerify: () => void;
  isVerified: boolean;
}

export default function SafetyNumberModal({ 
  safetyNumber, 
  userName, 
  onClose, 
  onVerify,
  isVerified
}: SafetyNumberModalProps) {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (safetyNumber) {
      setIsLoading(false);
    }
  }, [safetyNumber]);

  const formattedNumber = safetyNumber.replace(/(\d{5})/g, '$1 ').trim();

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div 
        className="
          bg-bg-surface rounded-3xl p-8 w-full max-w-md relative 
          shadow-neumorphic-convex border border-white/10
        " 
        onClick={e => e.stopPropagation()}
      >
        <button 
          onClick={onClose} 
          className="absolute top-4 right-4 p-2 rounded-full text-text-secondary shadow-neumorphic-convex active:shadow-neumorphic-pressed hover:text-red-500 transition-all"
        >
          <FiX size={20} />
        </button>
        
        <div className="flex flex-col items-center text-center">
          <div className="p-4 rounded-full bg-bg-main shadow-neumorphic-convex text-accent mb-4">
             <FiShield size={32} />
          </div>
          
          <h2 className="text-xl font-black uppercase tracking-wide text-text-primary">Safety Number</h2>
          <p className="text-xs text-text-secondary mt-2 mb-6 font-mono max-w-xs">
            Verify end-to-end encryption integrity with <span className="font-bold text-text-primary">{userName}</span>.
          </p>

          {isLoading ? (
            <div className="h-64 flex items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              <div className="my-2 p-6 bg-white rounded-2xl shadow-neumorphic-concave border-4 border-bg-main">
                <QRCode
                  value={formattedNumber}
                  size={160}
                  viewBox={`0 0 256 256`}
                />
              </div>
              
              <div className="w-full mt-6 mb-6">
                 <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary mb-2 block text-left pl-2">Fingerprint Hash</label>
                 <div className="
                   font-mono text-lg tracking-widest text-accent text-center
                   p-4 bg-bg-main rounded-xl shadow-neumorphic-concave
                   border border-white/5 break-all
                 ">
                   {formattedNumber}
                 </div>
              </div>
            </>
          )}

          {isVerified ? (
            <div className="flex items-center gap-2 text-green-500 font-bold uppercase text-xs tracking-wider bg-green-500/10 px-4 py-2 rounded-full">
               <FiCheck /> Verification Confirmed
            </div>
          ) : (
            <button 
              onClick={onVerify}
              className="
                w-full py-3 rounded-xl font-bold uppercase tracking-wider text-xs
                bg-accent text-white
                shadow-neumorphic-convex active:shadow-neumorphic-pressed
                hover:brightness-110 transition-all
              "
            >
              Confirm Safety Number
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
