import * as Popover from '@radix-ui/react-popover';
import { useAuthStore } from '@store/auth';
import { useMessageStore } from '@store/message';
import type { Message } from '@store/conversation';
import { api } from '@lib/api';

interface ReactionPopoverProps {
  message: Message;
  children: React.ReactNode; // Tombol pemicu
}

const COMMON_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

export default function ReactionPopover({ message, children }: ReactionPopoverProps) {
  const me = useAuthStore((s) => s.user);
  const { addReaction, removeReaction } = useMessageStore(s => ({ addReaction: s.addReaction, removeReaction: s.removeReaction }));

  const handleSelectReaction = async (emoji: string) => {
    if (!me) return;
    
    const userReaction = message.reactions?.find(r => r.userId === me.id);

    // If user clicks the same emoji, they are toggling it off.
    if (userReaction?.emoji === emoji) {
      removeReaction(message.conversationId, message.id, userReaction.id);
      await api(`/api/messages/reactions/${userReaction.id}`, { method: 'DELETE' }).catch(() => {
        // Revert on failure
        addReaction(message.conversationId, message.id, userReaction);
      });
      return;
    }

    // If user clicks a new emoji, handle adding/replacing
    const tempId = `temp-reaction-${Date.now()}`;
    const optimisticReaction = {
      id: tempId,
      emoji,
      userId: me.id,
      user: { id: me.id, name: me.name, username: me.username },
      tempId: tempId,
    };

    // Optimistically remove the old reaction if it exists
    if (userReaction) {
      removeReaction(message.conversationId, message.id, userReaction.id);
    }
    // Optimistically add the new one
    addReaction(message.conversationId, message.id, optimisticReaction);

    try {
      // Add the new reaction on the server first
      await api(`/api/messages/${message.id}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji, tempId }),
      });

      // If that succeeds, try to delete the old one, but don't revert the new one if this fails.
      if (userReaction) {
        try {
          await api(`/api/messages/reactions/${userReaction.id}`, { method: 'DELETE' });
        } catch (deleteError) {
          console.error("Failed to delete old reaction, but new reaction was successful:", deleteError);
          // The UI is already showing the new state, which is fine.
          // The old reaction might reappear on refresh, which is an acceptable inconsistency for now.
        }
      }
    } catch (error) {
      // This outer catch only handles the failure of the POST request.
      console.error("Failed to add new reaction:", error);
      // Revert all optimistic changes on failure
      removeReaction(message.conversationId, message.id, tempId);
      if (userReaction) {
        addReaction(message.conversationId, message.id, userReaction);
      }
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
