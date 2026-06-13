import { useRef, useState } from 'react';
import { Cropper, CropperRef } from 'react-advanced-cropper';
import 'react-advanced-cropper/dist/style.css';
import 'react-advanced-cropper/dist/themes/compact.css';
import { FiX, FiRotateCw } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

export default function AttachmentCropperModal({ 
  file, url, onClose, onSave 
}: { 
  file: File, url: string, onClose: () => void, onSave: (file: File) => void 
}) {
  const { t } = useTranslation(['modals', 'common']);
  const cropperRef = useRef<CropperRef>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleRotate = () => {
    if (cropperRef.current) {
        cropperRef.current.rotateImage(90);
    }
  };

  const handleSave = () => {
    if (!cropperRef.current) return;
    setIsProcessing(true);
    
    const canvas = cropperRef.current.getCanvas();
    if (!canvas) {
      toast.error(t('modals:editor.process_failed', 'Failed to process image.'));
      setIsProcessing(false);
      return;
    }

    canvas.toBlob((blob) => {
      if (blob) {
        // Create a new file with the original name and type
        const croppedFile = new File([blob], file.name, { type: file.type });
        onSave(croppedFile);
      } else {
        toast.error(t('modals:editor.blob_failed', 'Failed to generate image blob.'));
      }
      setIsProcessing(false);
    }, file.type, 0.95);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/95 backdrop-blur-xl md:p-4 overscroll-none">
      <div className="relative w-full h-full md:max-w-5xl md:h-[90vh] flex flex-col bg-bg-main md:rounded-3xl overflow-hidden shadow-[0_30px_100px_rgba(0,0,0,0.8)] border border-white/10">
        {/* Dynamic Image Area */}
        <div className="flex-1 w-full bg-black relative flex items-center justify-center overflow-hidden">
          <Cropper
            ref={cropperRef}
            src={url}
            className="h-full w-full object-contain"
            stencilProps={{
              grid: true,
            }}
            backgroundWrapperProps={{
              scaleImage: true,
            }}
          />
        </div>
        
        {/* Responsive Control Bar */}
        <div className="p-6 bg-bg-surface flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-white/5 pb-safe">
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button 
                onClick={onClose} 
                disabled={isProcessing} 
                aria-label={t('common:actions.close', 'Close')} 
                title={t('common:actions.close', 'Close')} 
                className="p-3.5 bg-red-500/10 text-red-500 rounded-2xl hover:bg-red-500/20 transition-all active:scale-90"
            >
                <FiX size={22} />
            </button>
            <button 
                onClick={handleRotate} 
                disabled={isProcessing} 
                className="flex items-center justify-center gap-2 p-3.5 bg-white/5 text-text-primary rounded-2xl hover:bg-white/10 transition-all flex-1 sm:px-6 font-black uppercase tracking-widest text-xs border border-white/5"
            >
                <FiRotateCw size={18} /> {t('modals:editor.rotate', 'Rotate')}
            </button>
          </div>

          <button 
            onClick={handleSave} 
            disabled={isProcessing} 
            aria-label={t('common:actions.save', 'Save')} 
            title={t('common:actions.save', 'Save')} 
            className="
                w-full sm:w-auto px-10 py-3.5 bg-accent text-white rounded-2xl 
                hover:scale-105 active:scale-95 transition-all 
                shadow-[0_15px_35px_rgba(var(--accent),0.5)]
                font-black uppercase tracking-tighter text-sm
                disabled:opacity-50 disabled:grayscale
            "
          >
            {isProcessing ? t('common:actions.processing') : t('common:actions.done')}
          </button>
        </div>
      </div>
    </div>
  );
}
