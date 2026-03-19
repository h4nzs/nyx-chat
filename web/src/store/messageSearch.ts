import { createWithEqualityFn } from "zustand/traditional";
import { shadowVault, decryptVaultText } from '@lib/shadowVaultDb';

type State = {
  searchResults: any[];
  highlightedMessageId: string | null;
  searchQuery: string;
  isSearching: boolean;
  currentSearchToken: string | null;
  
  // Actions
  searchMessages: (query: string, conversationId: string) => Promise<void>;
  setHighlightedMessageId: (messageId: string | null) => void;
  clearSearch: () => void;
};

export const useMessageSearchStore = createWithEqualityFn<State>((set, get) => ({
  searchResults: [],
  highlightedMessageId: null,
  searchQuery: '',
  isSearching: false,
  currentSearchToken: null,

  searchMessages: async (query, conversationId) => {
    const token = crypto.randomUUID();
    set({ searchQuery: query, isSearching: true, currentSearchToken: token });
    
    if (!query.trim()) {
      set({ searchResults: [], isSearching: false });
      return;
    }

    const normalizedQuery = query.toLowerCase();

    try {
      // 1. Fetch raw encrypted records for this conversation
      const rawResults = await shadowVault.messages
        .where('conversationId')
        .equals(conversationId)
        .reverse()
        .sortBy('createdAt');
        
      // 2. In-memory lightning decryption & filtering
      const decryptedResults = [];
      for (const msg of rawResults) {
        if (msg.isViewOnce || msg.isDeletedLocal || !msg.content) continue; // Skip phantom media and tombstones
        
        const plainText = await decryptVaultText(msg.content);
        if (plainText && plainText.toLowerCase().includes(normalizedQuery)) {
          // Reconstruct the message object with the decrypted text for the UI
          decryptedResults.push({ ...msg, content: plainText });
        }
      }
        
      // ONLY update if the query hasn't changed while we were decrypting
      if (get().currentSearchToken === token) {
        set({ searchResults: decryptedResults, isSearching: false });
      }
    } catch (error) {
      console.error("Iron Vault Search failed:", error);
      if (get().currentSearchToken === token) {
        set({ searchResults: [], isSearching: false });
      }
    }
  },

  setHighlightedMessageId: (messageId) => set({ highlightedMessageId: messageId }),
  
  clearSearch: () => set({ searchResults: [], searchQuery: '', isSearching: false, highlightedMessageId: null }),
}));
