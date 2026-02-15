import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useSettingsStore } from '../store/settings';

interface SmartReplyProps {
  lastMessage: string | null;
  onSelectReply: (reply: string) => void;
}

export default function SmartReply({ lastMessage, onSelectReply }: SmartReplyProps) {
  const { enableSmartReply } = useSettingsStore();
  const [replies, setReplies] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Don't call AI if disabled or no text
    if (!enableSmartReply || !lastMessage) {
      setReplies([]);
      return;
    }

    const fetchReplies = async () => {
      setLoading(true);
      try {
        const data = await api<{ replies: string[] }>('/api/ai/smart-reply', { 
            method: 'POST', 
            body: JSON.stringify({ message: lastMessage }) 
        });
        setReplies(data.replies || []);
      } catch (error) {
        console.error('Smart Reply error:', error);
      } finally {
        setLoading(false);
      }
    };

    // Debounce to prevent spamming the API
    const timer = setTimeout(fetchReplies, 1500);
    return () => clearTimeout(timer);
    
  }, [lastMessage, enableSmartReply]);

  if (!enableSmartReply || (replies.length === 0 && !loading)) return null;

  return (
    <div className="flex gap-2 overflow-x-auto px-4 py-2 bg-bg-surface border-t border-white/5 custom-scrollbar">
      {loading ? (
        <span className="text-xs text-text-secondary animate-pulse flex items-center gap-1">
          <span className="opacity-50">✨</span> AI is thinking...
        </span>
      ) : (
        replies.map((reply, i) => (
          <button
            key={i}
            onClick={() => onSelectReply(reply)}
            className="flex-shrink-0 px-4 py-1.5 text-xs font-medium rounded-full bg-bg-main border border-white/10 text-text-primary hover:border-accent hover:text-accent transition-all shadow-sm"
          >
            ✨ {reply}
          </button>
        ))
      )}
    </div>
  );
}
