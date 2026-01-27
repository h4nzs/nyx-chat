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
  if (!preview.title) return null;

  return (
    <a 
      href={preview.url} 
      target="_blank" 
      rel="noopener noreferrer" 
      className="block mt-2 bg-bg-surface/50 p-3 rounded-lg hover:bg-secondary transition-colors max-w-sm border border-black/5 dark:border-white/5"
    >
      {preview.image && (
        <img src={preview.image} alt={preview.title} className="w-full h-32 object-cover rounded-t-lg" />
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
