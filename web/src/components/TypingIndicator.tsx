import { usePresenceStore } from '@store/presence';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';

export default function TypingIndicator({ conversationId }: { conversationId: string }) {
  const { typingIndicators } = usePresenceStore();
  const { conversations } = useConversationStore();
  const { user: me } = useAuthStore();

  const activeConversation = conversations.find(c => c.id === conversationId);

  const typingUsers = typingIndicators.filter(
    indicator =>
      indicator.conversationId === conversationId &&
      indicator.isTyping &&
      indicator.id !== me?.id // Exclude current user
  );

  if (!typingUsers.length) return null;

  // Map typing user IDs to their names
  const typingUserNames = typingUsers.map(typingUser => {
    const participant = activeConversation?.participants.find(p => p.id === typingUser.id);
    return participant?.name || participant?.username || 'Someone'; // Fallback to 'Someone'
  });

  let message: string;
  if (typingUserNames.length === 1) {
    message = `${typingUserNames[0]} is typing...`;
  } else {
    message = `Multiple people are typing...`;
  }

  return (
    <div className="text-sm text-text-secondary pl-2 py-1 italic">
      {message}
    </div>
  );
}