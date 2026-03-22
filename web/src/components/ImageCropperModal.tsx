import { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import { FiCheck, FiX, FiRotateCw } from 'react-icons/fi';
import { getCroppedImg } from '../utils/canvasUtils';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

type Area = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export default function ImageCropperModal({ 
  file, url, aspect = 1, onClose, onSave 
}: { 
  file: File, url: string, aspect?: number, onClose: () => void, onSave: (file: File) => void 
}) {
  const { t } = useTranslation(['modals', 'common']);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const onCropComplete = useCallback((_croppedArea: Area, croppedAreaPixels: Area) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const handleSave = async () => {
    if (!croppedAreaPixels) return;
    try {
      setIsProcessing(true);
      const croppedFile = await getCroppedImg(url, croppedAreaPixels, rotation, file.name, file.type);
      onSave(croppedFile);
    } catch (e) {
      console.error(e);
      toast.error(t('modals:editor.crop_failed'));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg h-[75vh] flex flex-col bg-bg-main rounded-2xl overflow-hidden shadow-2xl border border-white/10">
        <div className="relative flex-1 bg-black">
          <Cropper
            image={url}
            crop={crop}
            zoom={zoom}
            rotation={rotation}
            aspect={aspect}
            onCropChange={setCrop}
            onCropComplete={onCropComplete}
            onZoomChange={setZoom}
          />
        </div>

        <div className="p-4 bg-bg-surface flex flex-col gap-4">
          {/* Controls */}
          <div className="flex items-center gap-4 px-2">
            <span className="text-xs text-text-secondary font-bold">{t('modals:editor.zoom')}</span>
            <input type="range" value={zoom} min={1} max={3} step={0.1} aria-label="Zoom" onChange={(e) => setZoom(Number(e.target.value))} className="flex-1 accent-accent" />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between gap-4">
            <button onClick={onClose} disabled={isProcessing} className="p-3 bg-red-500/10 text-red-500 rounded-xl hover:bg-red-500/20 transition-colors">
              <FiX size={20} />
            </button>
            <button onClick={() => setRotation((prev) => (prev + 90) % 360)} disabled={isProcessing} className="flex items-center justify-center gap-2 p-3 bg-white/5 text-text-primary rounded-xl hover:bg-white/10 transition-colors flex-1 font-bold text-sm">
              <FiRotateCw size={18} /> {t('modals:editor.rotate')}
            </button>
            <button onClick={handleSave} disabled={isProcessing} className="p-3 bg-accent text-white rounded-xl hover:scale-105 transition-all shadow-[0_0_15px_rgba(var(--accent),0.4)]">
              <FiCheck size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
