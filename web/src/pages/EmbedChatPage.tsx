import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { useConversationStore, type Conversation } from '../store/conversation';
import { authFetch } from '../lib/api';
import { setSecureCookie } from '../lib/tokenStorage';
import { Spinner } from '../components/Spinner';
import ChatWindow from '../components/ChatWindow';
import type { User } from '@nyx/shared';

export default function EmbedChatPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function initEmbed() {
      if (!id) {
        setError('Missing conversation ID');
        setLoading(false);
        return;
      }

      if (token) {
        setSecureCookie('at', token);
        useAuthStore.getState().setAccessToken(token);
      }

      try {
        const user = await authFetch<User>('/api/users/me');
        useAuthStore.getState().setUser(user);
        
        const conversation = await authFetch<Conversation>(`/api/conversations/${id}`);
        useConversationStore.getState().addOrUpdateConversation(conversation);
        useConversationStore.getState().openConversation(conversation.id);
        
        const { connectSocket } = await import('../lib/socket');
        connectSocket();
      } catch (err: unknown) {
        console.error('Embed initialization error:', err);
        setError('Failed to load chat. Please check your token or connection.');
      } finally {
        setLoading(false);
      }
    }

    initEmbed();
  }, [id, token]);

  if (loading) {
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-bg-main overflow-hidden">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-bg-main overflow-hidden">
        <div className="text-text-secondary text-sm">{error}</div>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen flex overflow-hidden bg-bg-main">
      <ChatWindow id={id!} onMenuClick={() => {}} />
    </div>
  );
}
