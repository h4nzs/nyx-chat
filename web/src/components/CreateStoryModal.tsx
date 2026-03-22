import { useState, useMemo, useEffect } from 'react';
import ModalBase from './ui/ModalBase';
import { useStoryStore } from '@store/story';
import { FiImage, FiX, FiEdit3, FiCrop, FiLock, FiUsers } from 'react-icons/fi';
import toast from 'react-hot-toast';
import ImageEditorModal from './ImageEditorModal';
import AttachmentCropperModal from './AttachmentCropperModal';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useProfileStore } from '@store/profile';
import { asUserId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

// --- Sub Component for E2EE Profile Rendering ---
const ContactItem = ({ contact, isSelected, onToggle }: { contact: { id: string; encryptedProfile?: string; username?: string; avatarUrl?: string; [key: string]: unknown }, isSelected: boolean, onToggle: () => void }) => {
  const { t } = useTranslation(['common']);
  const profile = useProfileStore(state => {
    const cacheKey = contact.encryptedProfile ? `${contact.id}_${contact.encryptedProfile.substring(0, 32)}` : contact.id;
    return state.profiles[cacheKey];
  });

  useEffect(() => {
     if (!profile && contact.encryptedProfile) {
        useProfileStore.getState().decryptAndCache(contact.id, contact.encryptedProfile);
     }
  }, [contact.id, contact.encryptedProfile, profile]);

  const name = profile?.name || contact.username || t('common:defaults.user');
  const avatarUrl = profile?.avatarUrl || contact.avatarUrl || `https://api.dicebear.com/8.x/initials/svg?seed=${encodeURIComponent(name)}`;

  return (
    <label className="flex items-center justify-between p-2 rounded-xl hover:bg-white/5 cursor-pointer transition-colors group">
      <div className="flex items-center gap-3">
        <img src={avatarUrl} alt="" className="w-9 h-9 rounded-full border border-white/10 group-hover:border-accent/50 transition-colors object-cover" />
        <span className="text-sm font-medium text-text-primary">{name}</span>
      </div>
      <input 
        type="checkbox" 
        checked={isSelected}
        onChange={onToggle}
        className="accent-accent rounded w-5 h-5 cursor-pointer"
      />
    </label>
  );
};

export default function CreateStoryModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['modals', 'common']);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [privacyMode, setPrivacyMode] = useState<'ALL' | 'EXCLUDE' | 'ONLY'>('ALL');
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [showPrivacySettings, setShowPrivacySettings] = useState(false);
  
  const [showPaintEditor, setShowPaintEditor] = useState(false);
  const [showCropper, setShowCropper] = useState(false);

  const conversations = useConversationStore(state => state.conversations);
  const me = useAuthStore(state => state.user);
  
  const contacts = useMemo(() => {
    const map = new Map();
    conversations.forEach(c => {
      if (!c.isGroup) {
        const other = c.participants.find(p => p.id !== me?.id);
        if (other) map.set(other.id, other);
      }
    });
    return Array.from(map.values());
  }, [conversations, me]);

  const toggleUser = (id: string) => {
    setSelectedUsers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(f));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text && !file) {
      toast.error(t('modals:create_story.error_empty'));
      return;
    }
    await useStoryStore.getState().postStory(file, text, privacyMode, selectedUsers.map(id => asUserId(id)));
    onClose();
  };

  const getSafeUrl = (url: string | null) => {
    if (!url) return undefined;
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    return undefined;
  };
  const safePreviewUrl = getSafeUrl(previewUrl);

  return (
    <>
      <ModalBase isOpen={true} onClose={onClose} title={t('modals:create_story.title')}>
        <form onSubmit={handleSubmit} className="space-y-4">
          
          {safePreviewUrl ? (
            <div className="relative w-full h-48 rounded-xl overflow-hidden bg-black/20 group">
               {file?.type.startsWith('video/') ? (
                 <video src={safePreviewUrl} className="w-full h-full object-contain" controls />
               ) : (
                 <img src={safePreviewUrl} alt={t('common:defaults.preview', 'Preview')} className="w-full h-full object-contain" />
               )}
               
               <div className="absolute top-2 right-2 flex items-center gap-2 opacity-100 transition-opacity">
                 {file?.type.startsWith('image/') && (
                   <>
                     <button 
                       type="button" 
                       onClick={() => setShowPaintEditor(true)} 
                       className="bg-black/60 hover:bg-accent text-white p-2 rounded-full backdrop-blur-md transition-colors" 
                       title={t('modals:editor.draw', 'Draw')}
                       aria-label={t('modals:editor.draw', 'Draw')}
                     >
                       <FiEdit3 size={14} />
                     </button>
                     <button 
                       type="button" 
                       onClick={() => setShowCropper(true)} 
                       className="bg-black/60 hover:bg-accent text-white p-2 rounded-full backdrop-blur-md transition-colors" 
                       title={t('modals:editor.crop', 'Crop')}
                       aria-label={t('modals:editor.crop', 'Crop')}
                     >
                       <FiCrop size={14} />
                     </button>
                   </>
                 )}
                 <button 
                   type="button" 
                   onClick={() => { setFile(null); setPreviewUrl(null); }} 
                   className="bg-black/60 hover:bg-red-500 text-white p-2 rounded-full backdrop-blur-md transition-colors" 
                   title={t('modals:editor.remove', 'Remove')}
                   aria-label={t('modals:editor.remove', 'Remove')}
                 >
                   <FiX size={14} />
                 </button>
               </div>
            </div>
          ) : (
            <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-white/10 rounded-xl hover:border-accent/50 hover:bg-accent/5 transition-all cursor-pointer">
              <FiImage size={32} className="text-text-secondary mb-2" />
              <span className="text-sm text-text-secondary">{t('modals:create_story.add_media')}</span>
              <input type="file" className="hidden" accept="image/*,video/*" onChange={handleFileChange} />
            </label>
          )}

          <textarea
            placeholder={t('modals:create_story.placeholder')}
            className="w-full p-4 bg-bg-surface border border-white/5 rounded-xl shadow-neu-inner text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none h-24"
            value={text}
            onChange={e => setText(e.target.value)}
          />

          <div className="flex flex-col pt-2">
            <button 
              type="button"
              onClick={() => setShowPrivacySettings(true)}
              className="flex items-center justify-center gap-2 text-xs bg-white/10 hover:bg-white/20 px-4 py-2 rounded-full text-text-secondary transition-colors mb-4 mx-auto backdrop-blur-md border border-white/5 shadow-sm"
            >
              <FiLock size={14} className="text-accent" />
              <span className="font-medium">
                {privacyMode === 'ALL' ? t('modals:create_story.privacy.all') : 
                 privacyMode === 'EXCLUDE' ? t('modals:create_story.privacy.exclude', { count: selectedUsers.length }) : 
                 t('modals:create_story.privacy.only', { count: selectedUsers.length })}
              </span>
            </button>

            <button 
              type="submit" 
              disabled={useStoryStore(state => state.isLoading)}
              className="w-full py-3 bg-accent text-white font-bold rounded-xl shadow-[0_0_15px_rgba(var(--accent),0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all"
            >
              {t('modals:create_story.post_button')}
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

      {showPrivacySettings && (
        <div className="fixed inset-0 z-[150] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-bg-main w-full max-w-sm rounded-3xl border border-white/10 flex flex-col max-h-[85vh] shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-white/5 flex justify-between items-center bg-black/20">
              <div className="flex items-center gap-2">
                <FiUsers className="text-accent" size={20} />
                <h3 className="font-bold text-text-primary text-lg">{t('modals:create_story.privacy.label')}</h3>
              </div>
              <button onClick={() => setShowPrivacySettings(false)} className="text-text-secondary hover:text-white p-1 bg-white/5 rounded-full transition-colors">
                <FiX size={18} />
              </button>
            </div>
            
            <div className="p-2 flex flex-col overflow-y-auto custom-scrollbar">
              <div className="p-3 space-y-4">
                <label className="flex items-center justify-between cursor-pointer p-3 rounded-xl hover:bg-white/5 transition-colors border border-transparent hover:border-white/5">
                  <span className="text-text-primary font-medium">{t('modals:create_story.privacy.option_all')}</span>
                  <input type="radio" name="privacy" checked={privacyMode === 'ALL'} onChange={() => { setPrivacyMode('ALL'); setSelectedUsers([]); }} className="accent-accent w-5 h-5" />
                </label>
                <label className="flex items-center justify-between cursor-pointer p-3 rounded-xl hover:bg-white/5 transition-colors border border-transparent hover:border-white/5">
                  <span className="text-text-primary font-medium">{t('modals:create_story.privacy.option_exclude')}</span>
                  <input type="radio" name="privacy" checked={privacyMode === 'EXCLUDE'} onChange={() => { setPrivacyMode('EXCLUDE'); setSelectedUsers([]); }} className="accent-accent w-5 h-5" />
                </label>
                <label className="flex items-center justify-between cursor-pointer p-3 rounded-xl hover:bg-white/5 transition-colors border border-transparent hover:border-white/5">
                  <span className="text-text-primary font-medium">{t('modals:create_story.privacy.option_only')}</span>
                  <input type="radio" name="privacy" checked={privacyMode === 'ONLY'} onChange={() => { setPrivacyMode('ONLY'); setSelectedUsers([]); }} className="accent-accent w-5 h-5" />
                </label>
              </div>

              {privacyMode !== 'ALL' && (
                <div className="mt-2 border-t border-white/5 pt-4 px-3">
                  <p className="text-[11px] font-bold text-text-secondary mb-3 uppercase tracking-wider px-2">{t('modals:create_story.privacy.select_contacts')}</p>
                  <div className="space-y-1">
                    {contacts.map((contact: { id: string; encryptedProfile?: string; username?: string; avatarUrl?: string; [key: string]: unknown }) => (
                      <ContactItem 
                        key={contact.id} 
                        contact={contact} 
                        isSelected={selectedUsers.includes(contact.id)} 
                        onToggle={() => toggleUser(contact.id)} 
                      />
                    ))}
                    {contacts.length === 0 ? <p className="text-xs text-text-secondary text-center py-6">{t('modals:create_story.privacy.no_contacts')}</p> : null}
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-white/5 bg-black/40">
              <button onClick={() => setShowPrivacySettings(false)} className="w-full bg-accent text-white py-3.5 rounded-2xl font-bold shadow-neu-pressed hover:scale-[1.02] active:scale-95 transition-all">
                {t('modals:create_story.privacy.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
