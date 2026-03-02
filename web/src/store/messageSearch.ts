import { createWithEqualityFn } from "zustand/traditional";
import { useMessageStore } from "./message";
import type { Message } from "./conversation";
import { shadowVault, decryptVaultText } from '@lib/shadowVaultDb';

type State = {
  searchResults: any[];
  highlightedMessageId: string | null;
  searchQuery: string;
  isSearching: boolean;
  
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

  searchMessages: async (query, conversationId) => {
    set({ searchQuery: query, isSearching: true });
    
    if (!query.trim()) {
      set({ searchResults: [], isSearching: false });
      return;
    }

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
        if (msg.isViewOnce) continue; // Skip phantom media
        
        const plainText = await decryptVaultText(msg.content);
        if (plainText && plainText.toLowerCase().includes(query.toLowerCase())) {
          // Reconstruct the message object with the decrypted text for the UI
          decryptedResults.push({ ...msg, content: plainText });
        }
      }
        
      set({ searchResults: decryptedResults, isSearching: false });
    } catch (error) {
      console.error("Iron Vault Search failed:", error);
      set({ searchResults: [], isSearching: false });
    }
  },

  setHighlightedMessageId: (messageId) => set({ highlightedMessageId: messageId }),
  
  clearSearch: () => set({ searchResults: [], searchQuery: '', isSearching: false, highlightedMessageId: null }),
}));
