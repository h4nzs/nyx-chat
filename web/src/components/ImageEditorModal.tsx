import { useRef, useState, useEffect } from 'react';
import { ReactSketchCanvas, ReactSketchCanvasRef } from 'react-sketch-canvas';
import { FiCornerUpLeft, FiCornerUpRight, FiCheck, FiX } from 'react-icons/fi';
import toast from 'react-hot-toast';

const COLORS = ['#FFFFFF', '#000000', '#FF3B30', '#10B981', '#007AFF', '#F59E0B'];

export default function ImageEditorModal({ file, onSave, onCancel }: { file: File; onSave: (file: File) => void; onCancel: () => void }) {
  const canvasRef = useRef<ReactSketchCanvasRef>(null);
  const [color, setColor] = useState(COLORS[2]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [imageUrl, setImageUrl] = useState<string>('');

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleSave = async () => {
    if (!canvasRef.current) return;
    setIsProcessing(true);
    try {
      // Check if user actually drew anything
      const paths = await canvasRef.current.exportPaths();
      if (!paths || paths.length === 0) {
        onSave(file); // No changes made, return original
        return;
      }
      
      const base64 = await canvasRef.current.exportImage('jpeg');
      const res = await fetch(base64);
      const blob = await res.blob();
      const newFile = new File([blob], `edited_${file.name}`, { type: 'image/jpeg' });
      onSave(newFile);
    } catch (error: any) {
      // Fallback if library strictly throws when empty
      if (error === 'No stroke found!' || error?.message === 'No stroke found!') {
        onSave(file);
      } else {
        toast.error("Failed to save image");
      }
    } finally {
      setIsProcessing(false);
    }
  };

  if (!imageUrl) return null;

  return (
    <div className="fixed inset-0 z-[120] bg-black flex flex-col">
      <div className="flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent z-10 absolute top-0 left-0 right-0 pointer-events-auto">
        <button onClick={onCancel} className="p-2 text-white/80 hover:text-white"><FiX size={24} /></button>
        <div className="flex gap-4">
          <button onClick={() => canvasRef.current?.undo()} className="p-2 text-white/80 hover:text-white"><FiCornerUpLeft size={20} /></button>
          <button onClick={() => canvasRef.current?.redo()} className="p-2 text-white/80 hover:text-white"><FiCornerUpRight size={20} /></button>
        </div>
      </div>
      <div className="absolute inset-0 top-16 bottom-20 overflow-hidden touch-none cursor-crosshair">
         <ReactSketchCanvas ref={canvasRef} strokeWidth={5} strokeColor={color} backgroundImage={imageUrl} className="!border-none !bg-transparent" preserveBackgroundImageAspectRatio="xMidYMid meet" width="100%" height="100%" style={{ pointerEvents: 'auto' }} />
      </div>
      <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 to-transparent flex items-center justify-between z-10">
        <div className="flex gap-2 bg-white/10 p-2 rounded-full backdrop-blur-md">
          {COLORS.map(c => <button key={c} onClick={() => setColor(c)} className={`w-6 h-6 rounded-full border-2 transition-transform ${color === c ? 'scale-125 border-white' : 'border-transparent'}`} style={{ backgroundColor: c }} />)}
        </div>
        <button onClick={handleSave} disabled={isProcessing} className="flex items-center gap-2 bg-accent text-white px-5 py-2.5 rounded-full font-bold shadow-[0_0_15px_rgba(var(--accent),0.4)] hover:scale-105 transition-transform">
          <FiCheck size={18} /> {isProcessing ? 'Saving...' : 'Done'}
        </button>
      </div>
    </div>
  );
}