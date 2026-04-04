import * as Popover from '@radix-ui/react-popover';
import { useAuthStore } from '@store/auth';
import { useMessageStore } from '@store/message';
import { useShallow } from 'zustand/react/shallow';
import type { Message } from '@store/conversation';

interface ReactionPopoverProps {
  message: Message;
  children: React.ReactNode;
}

const COMMON_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

export default function ReactionPopover({ message, children }: ReactionPopoverProps) {
  const me = useAuthStore((s) => s.user);
  
  // Tambahkan sendMessage ke dalam hook useShallow
  const { sendReaction, removeLocalReaction, sendMessage } = useMessageStore(useShallow(s => ({ 
    sendReaction: s.sendReaction, 
    removeLocalReaction: s.removeLocalReaction,
    sendMessage: s.sendMessage
  })));

  const handleSelectReaction = async (emoji: string) => {
    if (!me) return;
    
    // Check if I already reacted
    const userReaction = message.reactions?.find(r => r.userId === me.id);

    // 1. TOGGLE OFF (Jika mengklik emoji yang sama = Hapus Reaksi)
    if (userReaction?.emoji === emoji) {
      removeLocalReaction(message.conversationId, message.id, userReaction.id);

      // E2EE Tombstone: Kirim sinyal hapus reaksi ke lawan bicara
      const removeReactPayload = { type: "reaction_remove", targetMessageId: message.id, emoji: emoji };
      try {
          await sendMessage(message.conversationId, {
              content: JSON.stringify(removeReactPayload),
              isSilent: true
          });
      } catch (e) {
          console.error("Failed to send reaction remove:", e);
      }
      return;
    }

    // 2. REPLACE (Jika mengklik emoji berbeda = Hapus yang lama, kirim yang baru)
    if (userReaction) {
        // Hapus yang lama di UI Lokal
        removeLocalReaction(message.conversationId, message.id, userReaction.id);

        // E2EE Tombstone: Kirim sinyal hapus emoji lama
        const removeReactPayload = { type: "reaction_remove", targetMessageId: message.id, emoji: userReaction.emoji };
        try {
            await sendMessage(message.conversationId, {
                content: JSON.stringify(removeReactPayload),
                isSilent: true
            });
        } catch (e) {
            console.error("Failed to send reaction remove:", e);
        }
    }

    // 3. ADD NEW (Kirim Reaksi Baru)
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
