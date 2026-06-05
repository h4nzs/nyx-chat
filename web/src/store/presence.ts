import { create } from 'zustand';

type TypingIndicator = {
  id: string; // userId
  conversationId: string;
  isTyping: boolean;
};

type State = {
  onlineUsers: Set<string>;
  typingIndicators: TypingIndicator[];
  setOnlineUsers: (userIds: string[]) => void;
  userJoined: (userId: string) => void;
  userLeft: (userId: string) => void;
  addOrUpdate: (indicator: TypingIndicator) => void;
  clear: () => void;
};

export const usePresenceStore = create<State>((set) => ({
  onlineUsers: new Set(),
  typingIndicators: [],

  setOnlineUsers: (userIds) => set({ onlineUsers: new Set(userIds) }),

  userJoined: (userId) => {
    // FIX: Offline Sync Trigger
    import('./message').then(({ useMessageStore }) => {
       const messageStore = useMessageStore.getState();
       // Check in-memory pending decryptions
       const pendingFromUser = messageStore.pendingDecryptions.filter(m => m.senderId === userId);
       const convIdsToRetry = new Set(pendingFromUser.map(m => m.conversationId));
       
       // Also check active conversations in memory for any waiting_for_key messages from this user
       Object.entries(messageStore.messages).forEach(([cid, msgs]) => {
           if (msgs.some(m => m.senderId === userId && (m.content === 'waiting_for_key' || m.content === '[Requesting key to decrypt...]'))) {
               import('@nyx/shared').then(({ asConversationId }) => {
                   convIdsToRetry.add(asConversationId(cid));
               });
           }
       });

       convIdsToRetry.forEach(cid => {
           console.log(`[Offline Sync] User ${userId} came online. Retrying decryptions for ${cid}...`);
           messageStore.reDecryptPendingMessages(cid);
       });
    });

    return set(state => ({ onlineUsers: new Set(state.onlineUsers).add(userId) }));
  },

  userLeft: (userId) => set(state => {
    const newOnlineUsers = new Set(state.onlineUsers);
    newOnlineUsers.delete(userId);
    const newTypingIndicators = state.typingIndicators.filter(i => i.id !== userId);
    return { onlineUsers: newOnlineUsers, typingIndicators: newTypingIndicators };
  }),

  addOrUpdate: (indicator) => set(state => {
    const existing = state.typingIndicators.find(
      i => i.id === indicator.id && i.conversationId === indicator.conversationId
    );
    if (existing) {
      if (!indicator.isTyping) {
        return { typingIndicators: state.typingIndicators.filter(i => i.id !== indicator.id || i.conversationId !== indicator.conversationId) };
      }
      return state;
    } else if (indicator.isTyping) {
      return { typingIndicators: [...state.typingIndicators, indicator] };
    }
    return state;
  }),
  
  clear: () => set({ onlineUsers: new Set(), typingIndicators: [] }),
}));