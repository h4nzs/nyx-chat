import { createWithEqualityFn } from 'zustand/traditional';
import { api } from '@lib/api';
import { generateStoryKey, encryptStoryPayload, decryptStoryPayload } from '@lib/storyCrypto';
import { getStoryKey, saveStoryKey } from '@lib/shadowVaultDb';
import { useConversationStore } from './conversation';
import { useMessageStore } from './message';
import { encryptFile } from '@utils/crypto';
import { compressImage } from '@lib/fileUtils';
import toast from 'react-hot-toast';
import { useAuthStore } from './auth';

export type Story = {
  id: string;
  senderId: string;
  encryptedPayload: string;
  createdAt: string;
  expiresAt: string;
  // Decrypted fields
  decryptedData?: {
    text?: string;
    mediaUrl?: string;
    mimeType?: string;
    fileKey?: string;
  };
};

type StoryState = {
  stories: Record<string, Story[]>;
  isLoading: boolean;
  fetchActiveStories: (userId: string) => Promise<void>;
  postStory: (file: File | null, text: string, privacy: 'ALL' | 'EXCLUDE' | 'ONLY', selectedUserIds: string[]) => Promise<void>;
};

export const useStoryStore = createWithEqualityFn<StoryState>((set, get) => ({
  stories: {},
  isLoading: false,

  fetchActiveStories: async (userId: string) => {
    set({ isLoading: true });
    try {
      const rawStories = await api<Story[]>(`/api/stories/user/${userId}`);
      
      const decryptedStories = await Promise.all(rawStories.map(async (story) => {
        try {
          const base64Key = await getStoryKey(story.id);
          if (base64Key) {
            const decryptedData = await decryptStoryPayload(story.encryptedPayload, base64Key);
            return { ...story, decryptedData };
          }
        } catch (err) {
          console.error(`Failed to decrypt story ${story.id}`, err);
        }
        return story;
      }));

      set((state) => ({
        stories: {
          ...state.stories,
          [userId]: decryptedStories
        },
      }));
    } catch (e) {
      console.error('Failed to fetch stories', e);
    } finally {
      set({ isLoading: false });
    }
  },

  postStory: async (file, text, privacy, selectedUserIds) => {
    const toastId = toast.loading('Posting story...');
    try {
      const storyKey = await generateStoryKey();
      
      let mediaUrl = undefined;
      let mimeType = undefined;
      let fileKey = undefined;

      if (file) {
        toast.loading('Processing media...', { id: toastId });
        let fileToProcess = file;
        if (file.type.startsWith('image/')) {
           try { fileToProcess = await compressImage(file, false); } catch (e) {}
        }

        const { encryptedBlob, key: rawFileKey } = await encryptFile(fileToProcess);
        fileKey = rawFileKey;
        mimeType = file.type;

        const presignedRes = await api<{ uploadUrl: string, publicUrl: string, key: string }>('/api/uploads/presigned', {
            method: 'POST',
            body: JSON.stringify({
                fileName: file.name,
                fileType: 'application/octet-stream', 
                folder: 'stories',
                fileSize: encryptedBlob.size,
                fileRetention: 86400 // 24 hours
            })
        });

        await fetch(presignedRes.uploadUrl, { method: 'PUT', body: encryptedBlob, headers: { 'Content-Type': 'application/octet-stream' } });
        mediaUrl = presignedRes.publicUrl;
      }

      toast.loading('Encrypting...', { id: toastId });
      const payload = { text, mediaUrl, mimeType, fileKey };
      const encryptedPayload = await encryptStoryPayload(payload, storyKey);

      const response = await api<Story>('/api/stories', {
        method: 'POST',
        body: JSON.stringify({ encryptedPayload })
      });

      // Save our own key so we can view our own stories
      await saveStoryKey(response.id, storyKey);
      
      // FAN-OUT TARGETING LOGIC
      const me = useAuthStore.getState().user;
      const conversations = useConversationStore.getState().conversations;
      
      const allContacts = new Set<string>();
      conversations.forEach(c => {
        if (!c.isGroup) {
          const other = c.participants.find(p => p.id !== me?.id);
          if (other) allContacts.add(other.id);
        }
      });

      let targets: string[] = [];
      if (privacy === 'ALL') {
        targets = Array.from(allContacts);
      } else if (privacy === 'EXCLUDE') {
        targets = Array.from(allContacts).filter(id => !selectedUserIds.includes(id));
      } else if (privacy === 'ONLY') {
        targets = selectedUserIds.filter(id => allContacts.has(id));
      }

      // SEND SILENT KEYS
      const messageStore = useMessageStore.getState();
      toast.loading('Distributing keys securely...', { id: toastId });
      
      for (const targetId of targets) {
        const conv = conversations.find(c => !c.isGroup && c.participants.some(p => p.id === targetId));
        if (conv) {
          try {
            await messageStore.sendMessage(conv.id, {
              type: 'SYSTEM',
              content: `STORY_KEY:${JSON.stringify({ type: 'STORY_KEY', storyId: response.id, key: storyKey })}`,
              isSilent: true
            }, undefined, true);
          } catch (e) {
            console.error(`Failed to send story key to ${targetId}`, e);
          }
        }
      }

      // Add optimistic story locally
      const currentUser = useAuthStore.getState().user;
      if (!currentUser) return; // Prevent crash if logged out during upload
      
      const myStories = get().stories[currentUser.id] || [];
      set((state) => ({
        stories: {
          ...state.stories,
          [currentUser.id]: [...myStories, { ...response, decryptedData: payload }]
        }
      }));

      toast.success('Story posted!', { id: toastId });
    } catch (e: any) {
      console.error(e);
      toast.error(`Failed to post story: ${e.message || 'Unknown error'}`, { id: toastId });
    }
  }
}));
