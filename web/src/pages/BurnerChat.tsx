import React, { useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useBurnerStore } from '../store/burner';
import { getSocket, connectSocket } from '../lib/socket';
import { FiPaperclip, FiMic, FiSend } from 'react-icons/fi';
import MessageBubble from '../components/MessageBubble';
import type { Message } from '@nyx/shared';
import { api } from '../lib/api';
import toast from 'react-hot-toast';

export default function BurnerChat() {
  const location = useLocation();
  const { error, messages, initializeFromHash, sendMessage, activeSessions } = useBurnerStore();
  const [inputText, setInputText] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Extract roomId from hash
  const hashPart = location.hash.split('#')[1];
  const roomId = hashPart ? hashPart.split(':')[0] : '';
  const isInitialized = !!activeSessions[roomId]?.drState;

  useEffect(() => {
    const socket = getSocket();
    if (!socket?.connected) {
      connectSocket();
    }
  }, []);

  useEffect(() => {
    if (location.hash) {
      initializeFromHash(location.hash);
    }
    
    // Explicitly join the room for anonymous guest
    const socket = getSocket();
    if (socket && location.hash) {
       const hashPart = location.hash.split('#')[1];
       if (hashPart) {
          const [id] = hashPart.split(':');
          socket.emit('burner:join', { roomId: id });
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
      
      const { getSodiumLib } = await import('../utils/crypto');
      const sodium = await getSodiumLib();
      const fileKeyB64 = sodium.to_base64(rawFileKey, sodium.base64_variants.URLSAFE_NO_PADDING);

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
        fileKey: fileKeyB64 
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
            const isMe = msg.senderId === 'guest';
            
            let parsedContent = msg.content;
            let fileUrl, fileName, fileType, fileKey, fileSize;
            
            try {
               if (msg.content.startsWith('{')) {
                  const data = JSON.parse(msg.content);
                  if (data.type === 'file') {
                     parsedContent = data.text || '';
                     fileUrl = data.fileUrl;
                     fileName = data.fileName;
                     fileType = data.fileType;
                     fileKey = data.fileKey;
                     fileSize = data.fileSize;
                  }
               }
            } catch(e) {}

            const messageObj = {
              id: msg.id,
              conversationId: roomId || '',
              senderId: msg.senderId,
              content: parsedContent,
              createdAt: msg.createdAt,
              updatedAt: msg.createdAt,
              isSilent: false,
              isEdited: false,
              isViewOnce: false,
              isViewed: true,
              fileUrl, fileName, fileType, fileKey, fileSize
            } as unknown as Message;

            return (
              <MessageBubble 
                key={msg.id} 
                message={messageObj} 
                isOwn={isMe} 
                isLastInSequence={index === messages.length - 1}
              />
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
