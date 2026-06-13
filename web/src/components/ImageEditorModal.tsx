import { useRef, useState, useEffect } from 'react';
import { ReactSketchCanvas, ReactSketchCanvasRef } from 'react-sketch-canvas';
import { FiCornerUpLeft, FiCornerUpRight, FiCheck, FiX } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

const COLORS = ['#FFFFFF', '#000000', '#FF3B30', '#10B981', '#007AFF', '#F59E0B'];

export default function ImageEditorModal({ file, onSave, onCancel }: { file: File; onSave: (file: File) => void; onCancel: () => void }) {
  const { t } = useTranslation(['modals', 'common']);
  const canvasRef = useRef<ReactSketchCanvasRef>(null);
  const [color, setColor] = useState(COLORS[2]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [imageUrl, setImageUrl] = useState<string>('');
  const [aspectRatio, setAspectRatio] = useState<number>(1);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    
    const img = new Image();
    img.onload = () => {
      setAspectRatio(img.naturalWidth / img.naturalHeight);
    };
    img.src = url;

    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleSave = async () => {
    if (!canvasRef.current) return;
    setIsProcessing(true);
    try {
      const paths = await canvasRef.current.exportPaths();
      if (!paths || paths.length === 0) {
        onSave(file); 
        return;
      }

      // 1. Get strokes as SVG
      const svgData = await canvasRef.current.exportSvg();
      
      // 2. Create high-res composition canvas
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new Error("Could not create canvas context");

      // 3. Load Background Image (using ImageBitmap for robustness)
      const bitmap = await createImageBitmap(file);
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;

      // Draw background
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      // 4. Load and Draw SVG strokes
      const svg = new Image();
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const svgUrl = URL.createObjectURL(svgBlob);
      
      try {
        await new Promise((resolve, reject) => {
          svg.onload = resolve;
          svg.onerror = () => reject(new Error("SVG stroke layer failed to load"));
          svg.src = svgUrl;
        });

        // Draw strokes scaled exactly to original image size
        ctx.drawImage(svg, 0, 0, canvas.width, canvas.height);
      } finally {
        URL.revokeObjectURL(svgUrl);
      }

      // 5. Export to File (preserving original type or fallback to JPEG)
      const outputType = file.type || 'image/jpeg';
      canvas.toBlob((blob) => {
        if (blob) {
          const newFile = new File([blob], `edited_${file.name}`, { type: outputType });
          onSave(newFile);
        } else {
          throw new Error("Blob conversion failed");
        }
      }, outputType, 0.95);

    } catch (error: unknown) {
      console.error("Editor save error:", error);
      if (error === 'No stroke found!' || (error instanceof Error ? error.message : null) === 'No stroke found!') {
        onSave(file);
      } else {
        toast.error(t('modals:editor.save_failed'));
      }
    } finally {
      setIsProcessing(false);
    }
  };

  if (!imageUrl) return null;

  return (
    <div className="fixed inset-0 z-[120] bg-black flex flex-col items-center justify-center">
      <div className="flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent z-20 absolute top-0 left-0 right-0 pointer-events-auto">
        <button 
          onClick={onCancel} 
          aria-label={t('common:actions.cancel')}
          title={t('common:actions.cancel')}
          className="p-2 text-white/80 hover:text-white"
        >
          <FiX size={24} />
        </button>
        <div className="flex gap-4">
          <button 
            onClick={() => canvasRef.current?.undo()} 
            aria-label={t('modals:editor.undo', 'Undo')}
            title={t('modals:editor.undo', 'Undo')}
            className="p-2 text-white/80 hover:text-white"
          >
            <FiCornerUpLeft size={20} />
          </button>
          <button 
            onClick={() => canvasRef.current?.redo()} 
            aria-label={t('modals:editor.redo', 'Redo')}
            title={t('modals:editor.redo', 'Redo')}
            className="p-2 text-white/80 hover:text-white"
          >
            <FiCornerUpRight size={20} />
          </button>
        </div>
      </div>

      <div className="relative w-full h-full flex items-center justify-center p-4 md:p-10">
          <div 
            style={{ 
                aspectRatio: `${aspectRatio}`,
                maxHeight: '100%',
                maxWidth: '100%'
            }}
            className="shadow-2xl border border-white/10 overflow-hidden touch-none cursor-crosshair bg-black"
          >
             <ReactSketchCanvas 
                ref={canvasRef} 
                strokeWidth={5} 
                strokeColor={color} 
                canvasColor="transparent"
                backgroundImage={imageUrl} 
                className="!border-none !bg-transparent" 
                preserveBackgroundImageAspectRatio="xMidYMid meet" 
                width="100%" 
                height="100%" 
                style={{ pointerEvents: 'auto' }} 
             />
          </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 to-transparent flex items-center justify-between z-20">
        <div className="flex gap-2 bg-white/10 p-2 rounded-full backdrop-blur-md">
          {COLORS.map(c => (
            <button 
              key={c} 
              onClick={() => setColor(c)} 
              aria-label={`${t('modals:editor.pick_color', 'Pick color')} ${c}`}
              className={`w-6 h-6 rounded-full border-2 transition-transform ${color === c ? 'scale-125 border-white' : 'border-transparent'}`} 
              style={{ backgroundColor: c }} 
            />
          ))}
        </div>
        <button 
          onClick={handleSave} 
          disabled={isProcessing} 
          className="flex items-center gap-2 bg-accent text-white px-5 py-2.5 rounded-full font-bold shadow-[0_0_15px_rgba(var(--accent),0.4)] hover:scale-105 transition-transform"
        >
          <FiCheck size={18} /> {isProcessing ? t('common:actions.saving') : t('common:actions.done')}
        </button>
      </div>
    </div>
  );
}
