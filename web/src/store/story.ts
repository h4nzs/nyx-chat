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
import type { StoryId, UserId, ConversationId } from '@nyx/shared';
import { asStoryId, asUserId, asConversationId } from '@nyx/shared';

import type { Story } from '@nyx/shared';

type StoryState = {
  stories: Record<string, Story[]>;
  isLoading: boolean;
  fetchActiveStories: (userId: UserId) => Promise<void>;
  postStory: (file: File | null, text: string, privacy: 'ALL' | 'EXCLUDE' | 'ONLY', selectedUserIds: UserId[]) => Promise<void>;
};

export const useStoryStore = createWithEqualityFn<StoryState>((set, get) => ({
  stories: {},
  isLoading: false,

  fetchActiveStories: async (userId) => {
    set({ isLoading: true });
    try {
      const rawStories = await api<Story[]>(`/api/stories/user/${userId}`);
      const me = useAuthStore.getState().user;

      // ZERO-KNOWLEDGE PRIVACY FILTER:
      // Backend returns ALL stories (it's zero-knowledge, so it doesn't know who was excluded).
      // We must filter client-side: only keep stories we have decryption keys for.
      const validStories: Story[] = [];

      for (const story of rawStories) {
        // Always allow our own stories
        if (story.senderId === me?.id) {
          validStories.push(story);
          continue;
        }

        // For other users' stories, ONLY keep them if we actually received the key
        // (i.e., we were NOT excluded from viewing this story)
        const key = await getStoryKey(story.id);
        if (key) {
          validStories.push(story);
        }
      }

      // Now decrypt the filtered stories
      const decryptedStories = await Promise.all(validStories.map(async (story) => {
        try {
          const base64Key = await getStoryKey(story.id);
          if (base64Key) {
            const decryptedData = await decryptStoryPayload(story.encryptedPayload, base64Key);
            return { ...story, decryptedData: decryptedData as unknown as Record<string, unknown> };
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
           try { fileToProcess = await compressImage(file, false); } catch (_e) {}
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
      
      // Map actual userId to conversationId for O(1) lookups
      const userToConvMap = new Map<UserId, ConversationId>(); 
      
      conversations.forEach(c => {
        if (!c.isGroup && c.participants) {
          const otherParticipant = c.participants.find((p: Record<string, unknown>) => {
            const uId = p.userId || (p.user as Record<string, unknown>)?.id || p.id;
            return uId !== me?.id;
          });
          
          if (otherParticipant) {
            const actualUserId = (otherParticipant as Record<string, unknown>).userId || ((otherParticipant as Record<string, unknown>).user as Record<string, unknown>)?.id || (otherParticipant as Record<string, unknown>).id;
            if (actualUserId) {
              userToConvMap.set(asUserId(actualUserId as string), c.id);
            }
          }
        }
      });

      const allContacts = Array.from(userToConvMap.keys());
      let targets: UserId[] = [];
      
      if (privacy === 'ALL') {
        targets = allContacts;
      } else if (privacy === 'EXCLUDE') {
        // Exclude the user IDs checked in the UI
        targets = allContacts.filter(id => !selectedUserIds.includes(id));
      } else if (privacy === 'ONLY') {
        // Only include the user IDs checked in the UI
        targets = selectedUserIds.filter(id => userToConvMap.has(id));
      }

      // SEND SILENT KEYS
      const messageStore = useMessageStore.getState();
      toast.loading('Distributing keys securely...', { id: toastId });
      
      for (const targetId of targets) {
        const convId = userToConvMap.get(targetId);
        if (convId) {
          try {
            await messageStore.sendMessage(convId, {
              type: 'SYSTEM',
              content: `STORY_KEY:${JSON.stringify({ type: 'STORY_KEY', storyId: response.id, key: storyKey })}`,
              isSilent: true
            }, undefined, true);
          } catch (e) {
            console.error(`[Stories] Failed to send story key to user ${targetId}`, e);
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
    } catch (e: unknown) {
      console.error(e);
      toast.error(`Failed to post story: ${(e instanceof Error ? e.message : 'Unknown error') || 'Unknown error'}`, { id: toastId });
    }
  }
}));
