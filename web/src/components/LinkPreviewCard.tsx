import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/auth';

interface LinkPreviewProps {
  preview: {
    url: string;
    title: string;
    description: string;
    image: string;
    siteName: string;
  };
}

const LinkPreviewCard = ({ preview }: LinkPreviewProps) => {
  const [proxiedImage, setProxiedImage] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const token = useAuthStore(s => s.accessToken);

  useEffect(() => {
    if (!preview.image) return;

    let isMounted = true;
    let objectUrl: string | null = null;

    const fetchImage = async () => {
      try {
        const baseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/api\/?$/, "").replace(/\/$/, "");
        const res = await fetch(`${baseUrl}/api/previews/image?url=${encodeURIComponent(preview.image)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (res.ok && isMounted) {
          const blob = await res.blob();
          objectUrl = URL.createObjectURL(blob);
          setProxiedImage(objectUrl);
        } else {
          if (isMounted) setHasError(true);
        }
      } catch (e) {
        console.error('Failed to proxy image:', e);
        if (isMounted) setHasError(true);
      }
    };

    fetchImage();

    return () => {
      isMounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [preview.image, token]);

  if (!preview.title) return null;

  return (
    <a 
      href={preview.url} 
      target="_blank" 
      rel="noopener noreferrer" 
      className="block mt-2 bg-bg-surface/50 p-3 rounded-lg hover:bg-secondary transition-colors max-w-sm border border-black/5 dark:border-white/5"
    >
      {preview.image && !hasError && (
        <div className="w-full h-32 bg-black/20 dark:bg-white/5 rounded-t-lg flex items-center justify-center overflow-hidden">
           {proxiedImage ? (
              <img src={proxiedImage} alt={preview.title} className="w-full h-full object-cover" />
           ) : (
              <span className="animate-pulse w-6 h-6 rounded-full border-2 border-accent border-t-transparent" />
           )}
        </div>
      )}
      <div className="p-2">
        <p className="text-xs text-text-secondary truncate">{preview.siteName || new URL(preview.url).hostname}</p>
        <p className="font-bold text-text-primary truncate">{preview.title}</p>
        <p className="text-sm text-text-secondary line-clamp-2">{preview.description}</p>
      </div>
    </a>
  );
};

export default LinkPreviewCard;
