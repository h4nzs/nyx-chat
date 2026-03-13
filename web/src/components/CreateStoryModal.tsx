import { useState } from 'react';
import ModalBase from './ui/ModalBase';
import { useStoryStore } from '@store/story';
import { FiImage, FiX, FiEdit3, FiCrop } from 'react-icons/fi';
import toast from 'react-hot-toast';
import ImageEditorModal from './ImageEditorModal';
import AttachmentCropperModal from './AttachmentCropperModal';

export default function CreateStoryModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState<'ALL' | 'EXCLUDE' | 'ONLY'>('ALL');
  
  const [showPaintEditor, setShowPaintEditor] = useState(false);
  const [showCropper, setShowCropper] = useState(false);

  // Minimal implementation for Stage 3: Assuming 'ALL' for simplicity, 
  // but keeping state for future expandability.

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setPreviewUrl(URL.createObjectURL(f));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text && !file) {
      toast.error('Add text or media to your story');
      return;
    }
    await useStoryStore.getState().postStory(file, text, privacy, []);
    onClose();
  };

  return (
    <ModalBase isOpen={true} onClose={onClose} title="Create Story">
      <form onSubmit={handleSubmit} className="space-y-4">
        
        {previewUrl ? (
          <div className="relative w-full h-48 rounded-xl overflow-hidden bg-black/20 group">
             {file?.type.startsWith('video/') ? (
               <video src={previewUrl} className="w-full h-full object-contain" controls />
             ) : (
               <img src={previewUrl} alt="preview" className="w-full h-full object-contain" />
             )}
             
             <div className="absolute top-2 right-2 flex items-center gap-2 opacity-100 transition-opacity">
               {file?.type.startsWith('image/') && (
                 <>
                   <button type="button" onClick={() => setShowPaintEditor(true)} className="bg-black/60 hover:bg-accent text-white p-2 rounded-full backdrop-blur-md transition-colors" title="Draw">
                     <FiEdit3 size={14} />
                   </button>
                   <button type="button" onClick={() => setShowCropper(true)} className="bg-black/60 hover:bg-accent text-white p-2 rounded-full backdrop-blur-md transition-colors" title="Crop">
                     <FiCrop size={14} />
                   </button>
                 </>
               )}
               <button type="button" onClick={() => { setFile(null); setPreviewUrl(null); }} className="bg-black/60 hover:bg-red-500 text-white p-2 rounded-full backdrop-blur-md transition-colors" title="Remove">
                 <FiX size={14} />
               </button>
             </div>
          </div>
        ) : (
          <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-white/10 rounded-xl hover:border-accent/50 hover:bg-accent/5 transition-all cursor-pointer">
            <FiImage size={32} className="text-text-secondary mb-2" />
            <span className="text-sm text-text-secondary">Add Media (Optional)</span>
            <input type="file" className="hidden" accept="image/*,video/*" onChange={handleFileChange} />
          </label>
        )}

        <textarea
          placeholder="What's on your mind? (End-to-End Encrypted)"
          className="w-full p-4 bg-bg-surface border border-white/5 rounded-xl shadow-neu-inner text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none h-24"
          value={text}
          onChange={e => setText(e.target.value)}
        />

        <div className="flex justify-between items-center pt-4">
          <select 
            value={privacy} 
            onChange={(e) => setPrivacy(e.target.value as any)}
            className="bg-bg-main text-xs text-text-secondary px-3 py-2 rounded-lg border border-white/5"
          >
            <option value="ALL">All Contacts</option>
            <option value="EXCLUDE" disabled>Exclude... (Soon)</option>
            <option value="ONLY" disabled>Only Share With... (Soon)</option>
          </select>

          <button 
            type="submit" 
            disabled={useStoryStore.getState().isLoading}
            className="px-6 py-2 bg-accent text-white font-bold rounded-lg hover:shadow-lg transition-all"
          >
            Post Story
          </button>
        </div>
      </form>
      
      {showPaintEditor && file && previewUrl && (
        <ImageEditorModal 
          file={file} 
          onSave={(f) => { setFile(f); setPreviewUrl(URL.createObjectURL(f)); setShowPaintEditor(false); }} 
          onCancel={() => setShowPaintEditor(false)} 
        />
      )}
      
      {showCropper && file && previewUrl && (
        <AttachmentCropperModal 
          file={file} 
          url={previewUrl}
          onSave={(f) => { setFile(f); setPreviewUrl(URL.createObjectURL(f)); setShowCropper(false); }} 
          onClose={() => setShowCropper(false)} 
        />
      )}
    </ModalBase>
  );
}
