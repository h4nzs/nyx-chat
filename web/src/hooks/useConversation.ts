import { useConversationStore } from '@store/conversation';
import { useMessageStore } from '@store/message';
import { useMessageInputStore } from '@store/messageInput';
import { useMemo } from 'react';
import type { Message } from '@store/conversation';

export function useConversation(conversationId: string) {
  const conversation = useConversationStore(state => 
    state.conversations.find(c => c.id === conversationId)
  );
  
  const { messages, hasMore, isFetchingMore, loadPreviousMessages, loadMessagesForConversation } = useMessageStore(state => ({
    messages: state.messages[conversationId] || [],
    hasMore: state.hasMore[conversationId],
    isFetchingMore: state.isFetchingMore[conversationId],
    loadPreviousMessages: state.loadPreviousMessages,
    loadMessagesForConversation: state.loadMessagesForConversation,
  }));

  const { sendMessage, uploadFile, retrySendMessage } = useMessageInputStore(state => ({
    sendMessage: state.sendMessage,
    uploadFile: state.uploadFile,
    retrySendMessage: state.retrySendMessage,
  }));

  const actions = useMemo(() => ({
    loadPrevious: () => loadPreviousMessages(conversationId),
    loadMessages: () => loadMessagesForConversation(conversationId),
    sendMessage: (data: { content: string }) => sendMessage(conversationId, data),
    uploadFile: (file: File) => uploadFile(conversationId, file),
    retrySendMessage: (message: Message) => retrySendMessage(message),
  }), [conversationId, loadPreviousMessages, loadMessagesForConversation, sendMessage, uploadFile, retrySendMessage]);

  return {
    conversation,
    messages,
    actions,
    hasMore,
    isFetchingMore,
    // Add a general loading state, true if conversation is missing but id is present
    isLoading: !!conversationId && !conversation, 
    // You can add a more specific error state if needed
    error: null, 
  };
}
