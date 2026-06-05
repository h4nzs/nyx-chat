import React, { useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useBurnerStore } from '../store/burner';
import { useAuthStore } from '../store/auth';
import { useTranslation } from 'react-i18next';
import { transportClient, connectSocket } from '../lib/transportClient';
import { FiPaperclip, FiMic, FiSend } from 'react-icons/fi';
import MessageBubble from '../components/MessageBubble';
import type { Message } from '@nyx/shared';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import clsx from 'clsx';

export default function BurnerChat() {
  const { t } = useTranslation(['chat']);
  const location = useLocation();
  const { error, messages, isInitialized, initializeFromHash, sendMessage, activeSessions, hostUserId } = useBurnerStore();
  const currentUser = useAuthStore(state => state.user);
  
  const [inputText, setInputText] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isHost = currentUser ? (hostUserId ? currentUser.id === hostUserId : true) : false;

  // Extract roomId from hash for reference
  const hashPart = location.hash.split('#')[1];
  const roomId = hashPart ? hashPart.split(':')[0] : '';

  useEffect(() => {
    // SECURITY: If we were a Guest, we MUST wipe the previous state on reload
    // to prevent "Split-Brain" where the Guest has a new identity but the Store/Host
    // thinks we are still using the old one.
    const currentUserState = useAuthStore.getState().user;
    if (currentUserState?.id.startsWith('guest_')) {
       console.log("[Burner] Wiping stale guest session for fresh start...");
       useAuthStore.setState({ user: null, accessToken: null });
       localStorage.removeItem('user');
       localStorage.removeItem('deviceId');
    }
  }, []); // Run ONCE on mount

  useEffect(() => {
    const initSocket = async () => {
      const socket = transportClient;
      
      // Jika Guest (tidak ada user login), minta token sementara
      if (!currentUser && !socket.connected) {
         try {
            const res = await api<{ accessToken: string; user: any; deviceId: string }>('/api/auth/burner', {
              method: 'POST'
            });
            
            // Simpan token sementara di Auth Store
            useAuthStore.getState().setAccessToken(res.accessToken);
            useAuthStore.getState().setUser(res.user);
            localStorage.setItem('deviceId', res.deviceId);
            
            connectSocket();
         } catch (e) {
            console.error("Failed to get guest token:", e);
            toast.error("Failed to initialize guest session. Please try again.");
         }
      } else if (!socket.connected) {
        connectSocket();
      }
    };
    
    initSocket();

    // Reconnect handler for Guests
    const handleDisconnect = () => {
      if (!useAuthStore.getState().user?.id.startsWith('guest_')) return;
      
      // Auto-reconnect guest after a short delay
      setTimeout(() => {
        if (!transportClient.connected) {
          initSocket();
        }
      }, 2000);
    };

    transportClient.on('disconnect', handleDisconnect);
    return () => {
      transportClient.off('disconnect', handleDisconnect);
    };
  }, [currentUser]);

  useEffect(() => {
    if (location.hash) {
      initializeFromHash(location.hash);
    }
    
    // Explicitly join the room for anonymous guest
    const socket = transportClient;
    if (socket && location.hash) {
       const hashPart = location.hash.split('#')[1];
       if (hashPart) {
          const [id] = hashPart.split(':');
          transportClient.sendEvent('burner:join', { roomId: id });
       }
    }
  }, [location.hash, initializeFromHash]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    await sendMessage(inputText);
    setInputText('');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      // 1. Encrypt file using worker
      const { encryptFileViaWorker } = await import('../utils/crypto');
      const encryptRes = await encryptFileViaWorker(file);
      const encryptedBlob = encryptRes.encryptedBlob;
      const rawFileKey = encryptRes.key;
      
      // 2. Get Presigned URL
      const presignedRes = await api<{ uploadUrl: string, publicUrl: string, key: string }>('/api/uploads/burner-presigned', {
          method: 'POST',
          body: JSON.stringify({
              fileName: file.name,
              fileType: 'application/octet-stream',
              folder: 'attachments',
              fileSize: encryptedBlob.size,
              fileRetention: 0
          })
      });

      // 3. Upload file
      await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', presignedRes.uploadUrl, true);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.onload = () => {
              if (xhr.status === 200) resolve();
              else reject(new Error('Upload failed'));
          };
          xhr.onerror = () => reject(new Error('Upload failed'));
          xhr.send(encryptedBlob);
      });

      // 4. Send Message JSON
      const finalContent = JSON.stringify({
        type: "file",
        text: "",
        fileUrl: presignedRes.publicUrl,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        fileKey: rawFileKey 
      });

      await sendMessage(finalContent);
    } catch (err) {
      console.error(err);
      toast.error('Failed to upload file');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <div className="bg-red-500/10 text-red-500 p-4 rounded-xl border border-red-500/20 max-w-md text-center">
          <h2 className="text-xl font-bold mb-2">Burner Session Failed</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!isInitialized) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="animate-pulse flex flex-col items-center">
          <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-text-secondary">Establishing Quantum-Secure Burner Session...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-bg-main relative">
      <header className="flex items-center justify-between p-4 border-b border-border bg-bg-surface/50 backdrop-blur-md sticky top-0 z-10">
        <div>
          <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            Burner Session
          </h1>
          <p className="text-xs text-text-secondary">RAM-Only &bull; PQ-DR Encrypted</p>
        </div>
      </header>

      {!isHost && (
        <div className="bg-yellow-500/10 text-yellow-500 p-3 mx-4 mt-4 rounded-lg border border-yellow-500/20 text-sm">
          <p className="font-bold flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            {t('chat:banners.burner_warning_title', 'Ephemeral Session Active')}
          </p>
          <p className="mt-1 opacity-90">
            {t('chat:banners.burner_warning_desc', 'Do not refresh or close this page. All chat history is RAM-only and will be permanently lost.')}
          </p>
        </div>
      )}

      <main className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-secondary space-y-2 opacity-50">
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p>Session is live. Messages are ephemeral.</p>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isMe = msg.senderId === (isHost ? 'host' : 'guest');
            
            const messageObj = {
              id: msg.id,
              conversationId: roomId || '',
              senderId: msg.senderId,
              content: msg.content,
              createdAt: msg.createdAt,
              updatedAt: msg.createdAt,
              type: msg.fileUrl ? 'FILE' : 'TEXT', // WAJIB UNTUK MERENDER COMPONENT BUBBLE NYX
              fileUrl: msg.fileUrl,
              fileName: msg.fileName,
              fileType: msg.fileType,
              fileKey: msg.fileKey,
              fileSize: msg.fileSize,
              isSilent: false,
              isEdited: false,
              isViewOnce: false,
              isViewed: true,
            } as unknown as Message;

            return (
              <div 
                key={msg.id} 
                className={clsx("flex w-full", {
                  "justify-end": isMe,
                  "justify-start": !isMe
                })}
              >
                <MessageBubble 
                  message={messageObj} 
                  isOwn={isMe} 
                  isLastInSequence={index === messages.length - 1}
                />
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </main>

      <footer className="p-4 bg-bg-surface/50 border-t border-border">
        {isUploading && (
           <div className="text-xs text-accent mb-2 px-2 animate-pulse">Uploading encrypted attachment...</div>
        )}
        <form onSubmit={handleSend} className="flex gap-2 items-center bg-bg-main border border-border rounded-full pr-2 pl-1 py-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-2 text-text-secondary hover:text-accent transition-colors rounded-full"
          >
            <FiPaperclip size={20} />
          </button>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileUpload} 
            className="hidden" 
          />
          
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type an ephemeral message..."
            className="flex-1 bg-transparent px-2 py-2 text-text-primary focus:outline-none placeholder-text-secondary/50"
            autoFocus
          />
          
          {inputText.trim() ? (
            <button
              type="submit"
              disabled={isUploading}
              className="bg-accent hover:bg-accent/90 disabled:opacity-50 text-white rounded-full p-2 w-10 h-10 flex items-center justify-center transition-colors"
            >
              <FiSend size={18} />
            </button>
          ) : (
            <button
              type="button"
              className="text-text-secondary hover:text-accent p-2 rounded-full transition-colors"
            >
              <FiMic size={20} />
            </button>
          )}
        </form>
      </footer>
    </div>
  );
}
