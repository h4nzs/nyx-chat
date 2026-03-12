import { useRef, useState } from 'react';
import { Cropper, CropperRef } from 'react-advanced-cropper';
import 'react-advanced-cropper/dist/style.css';
import { FiCheck, FiX, FiRotateCw } from 'react-icons/fi';
import toast from 'react-hot-toast';

export default function AttachmentCropperModal({ 
  file, url, onClose, onSave 
}: { 
  file: File, url: string, onClose: () => void, onSave: (file: File) => void 
}) {
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
      toast.error("Failed to process image.");
      setIsProcessing(false);
      return;
    }

    canvas.toBlob((blob) => {
      if (blob) {
        // Create a new file with the original name and type
        const croppedFile = new File([blob], file.name, { type: file.type });
        onSave(croppedFile);
      } else {
        toast.error("Failed to generate image blob.");
      }
      setIsProcessing(false);
    }, file.type, 0.95);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-md p-2 md:p-4">
      <div className="relative w-full max-w-4xl h-[85vh] flex flex-col bg-bg-main rounded-2xl overflow-hidden shadow-2xl border border-white/10">
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
        
        <div className="p-4 bg-bg-surface flex items-center justify-between gap-4 border-t border-white/5">
          <button onClick={onClose} disabled={isProcessing} className="p-3 bg-red-500/10 text-red-500 rounded-xl hover:bg-red-500/20 transition-colors">
            <FiX size={20} />
          </button>
          <button onClick={handleRotate} disabled={isProcessing} className="flex items-center justify-center gap-2 p-3 bg-white/5 text-text-primary rounded-xl hover:bg-white/10 transition-colors flex-1 font-bold text-sm">
            <FiRotateCw size={18} /> Rotate
          </button>
          <button onClick={handleSave} disabled={isProcessing} className="p-3 bg-accent text-white rounded-xl hover:scale-105 transition-all shadow-[0_0_15px_rgba(var(--accent),0.4)]">
            <FiCheck size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
