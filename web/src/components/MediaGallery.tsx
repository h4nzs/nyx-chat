import { useState, useEffect } from 'react';
import { useMessageStore } from '@store/message';
import { FiFile, FiImage, FiVideo, FiMusic } from 'react-icons/fi';
import { toAbsoluteUrl } from '@utils/url';

interface MediaItem {
  id: string;
  content: string; // URL to the media
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
  fileName?: string;
}

const MediaIcon = ({ type }: { type: MediaItem['type'] }) => {
  switch (type) {
    case 'IMAGE':
      return <FiImage className="w-8 h-8 text-text-secondary" />;
    case 'VIDEO':
      return <FiVideo className="w-8 h-8 text-text-secondary" />;
    case 'AUDIO':
      return <FiMusic className="w-8 h-8 text-text-secondary" />;
    default:
      return <FiFile className="w-8 h-8 text-text-secondary" />;
  }
};

const MediaGallery = ({ conversationId }: { conversationId: string }) => {
  const messages = useMessageStore(state => state.messages[conversationId] || []);
  const [media, setMedia] = useState<MediaItem[]>([]);

  useEffect(() => {
    // Filter decrypted messages locally
    const mediaMessages = messages.filter(m => {
        // Must have file data and NOT be an error/pending state
        const hasFile = m.fileUrl && !m.content?.startsWith('waiting_for') && !m.error;
        // Or if it's an image url type (legacy or direct)
        const hasImage = m.imageUrl;
        return hasFile || hasImage;
    }).map(m => {
        let type: MediaItem['type'] = 'DOCUMENT';
        if (m.fileType?.startsWith('image/') || m.imageUrl) type = 'IMAGE';
        else if (m.fileType?.startsWith('video/')) type = 'VIDEO';
        else if (m.fileType?.startsWith('audio/')) type = 'AUDIO';

        return {
            id: m.id,
            content: m.fileUrl || m.imageUrl || '',
            type,
            fileName: m.fileName || undefined // Handle null
        };
    }).reverse(); // Newest first

    setMedia(mediaMessages);
  }, [messages]);

  if (media.length === 0) {
    return (
        <div className="flex flex-col items-center justify-center p-8 opacity-50">
            <FiFile size={40} className="mb-2" />
            <p className="text-center text-xs text-text-secondary">No decrypted media found in local history.</p>
        </div>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-2 p-1 max-h-[400px] overflow-y-auto">
      {media.map((item) => (
        <a 
          key={item.id} 
          href={toAbsoluteUrl(item.content)} 
          target="_blank" 
          rel="noopener noreferrer"
          className="aspect-square bg-bg-surface rounded-lg shadow-neumorphic-convex flex items-center justify-center overflow-hidden group transition-all active:shadow-neumorphic-pressed relative"
        >
          {item.type === 'IMAGE' ? (
            <img src={toAbsoluteUrl(item.content)} alt={item.fileName || 'Shared media'} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-center p-2">
              <MediaIcon type={item.type} />
              {item.fileName && <span className="text-[10px] text-text-secondary truncate w-full px-1">{item.fileName}</span>}
            </div>
          )}
          {/* Type Badge */}
          {item.type !== 'IMAGE' && (
              <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded-md bg-black/50 text-[8px] font-bold text-white uppercase backdrop-blur-sm">
                  {item.type}
              </div>
          )}
        </a>
      ))}
    </div>
  );
};

export default MediaGallery;
