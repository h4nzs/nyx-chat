import * as Popover from '@radix-ui/react-popover';
import { useAuthStore } from '@store/auth';
import { useMessageStore } from '@store/message';
import type { Message } from '@store/conversation';
import { api } from '@lib/api';

interface ReactionPopoverProps {
  message: Message;
  children: React.ReactNode;
}

const COMMON_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

export default function ReactionPopover({ message, children }: ReactionPopoverProps) {
  const me = useAuthStore((s) => s.user);
  const { sendReaction, removeLocalReaction } = useMessageStore(s => ({ 
    sendReaction: s.sendReaction, 
    removeLocalReaction: s.removeLocalReaction 
  }));

  const handleSelectReaction = async (emoji: string) => {
    if (!me) return;
    
    // Check if I already reacted
    const userReaction = message.reactions?.find(r => r.userId === me.id);

    // 1. TOGGLE OFF (If clicking same emoji)
    if (userReaction?.emoji === emoji) {
      // Optimistic remove
      removeLocalReaction(message.conversationId, message.id, userReaction.id);
      
      // Server remove
      try {
        if (userReaction.isMessage) {
            // New "Reactions as Messages"
            await api(`/api/messages/${userReaction.id}`, { method: 'DELETE' });
        } else {
            // Legacy "MessageReaction" table
            await api(`/api/messages/reactions/${userReaction.id}`, { method: 'DELETE' });
        }
      } catch (e) {
        console.error("Failed to remove reaction:", e);
      }
      return;
    }

    // 2. REPLACE (If clicking different emoji)
    if (userReaction) {
        // Remove old one first
        removeLocalReaction(message.conversationId, message.id, userReaction.id);
        
        const deletePromise = userReaction.isMessage
            ? api(`/api/messages/${userReaction.id}`, { method: 'DELETE' })
            : api(`/api/messages/reactions/${userReaction.id}`, { method: 'DELETE' });
            
        deletePromise.catch(console.error);
    }

    // 3. ADD NEW (Send as message)
    // Optimistic update is handled inside sendReaction store action
    try {
        await sendReaction(message.conversationId, message.id, emoji);
    } catch (e) {
        console.error("Failed to send reaction:", e);
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content 
          side="top" 
          align="center" 
          sideOffset={10}
          className="flex gap-2 bg-bg-surface/80 backdrop-blur-sm rounded-full px-3 py-2 shadow-lg z-[99] border border-border"
        >
          {COMMON_EMOJIS.map(emoji => (
            <button 
              key={emoji} 
              onClick={() => handleSelectReaction(emoji)}
              className="text-2xl hover:scale-125 transition-transform duration-150 ease-in-out"
            >
              {emoji}
            </button>
          ))}
          <Popover.Arrow className="fill-current text-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
