import { describe, it, expect, beforeEach } from 'vitest';
import { useMessageStore } from './message';
import type { Message } from './conversation';

describe('useMessageStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    useMessageStore.setState({ messages: {} });
  });

  const conversationId = 'conv1';
  const tempId = 123;
  const optimisticMessage: Message = {
    id: `temp-${tempId}`,
    tempId: tempId,
    conversationId,
    senderId: 'user1',
    content: 'Hello',
    createdAt: new Date().toISOString(),
    optimistic: true,
  };

  it('should add an optimistic message', () => {
    // Check initial state
    expect(useMessageStore.getState().messages[conversationId]).toBeUndefined();

    // Add message
    useMessageStore.getState().addOptimisticMessage(conversationId, optimisticMessage);

    // Check final state
    const messages = useMessageStore.getState().messages[conversationId];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('temp-123');
    expect(messages[0].optimistic).toBe(true);
  });

  it('should replace an optimistic message with the real one', () => {
    // Setup: add an optimistic message first
    useMessageStore.getState().addOptimisticMessage(conversationId, optimisticMessage);

    const finalMessage: Message = {
      id: 'real-id-456',
      conversationId,
      senderId: 'user1',
      content: 'Hello',
      createdAt: new Date().toISOString(),
    };

    // Replace message
    useMessageStore.getState().replaceOptimisticMessage(conversationId, tempId, finalMessage);

    // Check final state
    const messages = useMessageStore.getState().messages[conversationId];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('real-id-456');
    expect(messages[0].optimistic).toBe(false);
    expect(messages[0].tempId).toBeUndefined(); // tempId is cleared when replacing with real message
  });
});
