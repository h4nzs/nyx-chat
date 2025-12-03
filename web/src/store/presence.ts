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

  userJoined: (userId) => set(state => ({ onlineUsers: new Set(state.onlineUsers).add(userId) })),

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