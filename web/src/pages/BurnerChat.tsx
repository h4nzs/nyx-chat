import React, { useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useBurnerStore } from '../store/burner';
import { getSocket, connectSocket } from '../lib/socket';

export default function BurnerChat() {
  const location = useLocation();
  const { isInitialized, error, messages, initializeFromHash, sendMessage } = useBurnerStore();
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // If socket isn't connected (guest user not logged in), connect it manually.
    // In NYX, if there's no JWT, socket connection still establishes but as an anonymous socket.
    // Since Burner Chat is host-to-guest and the host relies on socket routing,
    // the guest must be connected to the socket server.
    const socket = getSocket();
    if (!socket?.connected) {
      connectSocket();
    }
  }, []);

  useEffect(() => {
    if (location.hash) {
      initializeFromHash(location.hash);
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
    <div className="flex flex-col h-full w-full bg-bg-main">
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
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.senderId === 'guest' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                  msg.senderId === 'guest'
                    ? 'bg-accent text-white rounded-tr-sm'
                    : 'bg-bg-surface border border-border text-text-primary rounded-tl-sm'
                }`}
              >
                <p className="break-words">{msg.content}</p>
                <p className="text-[10px] opacity-60 mt-1 text-right">
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </main>

      <footer className="p-4 bg-bg-surface/50 border-t border-border">
        <form onSubmit={handleSend} className="flex gap-2">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type an ephemeral message..."
            className="flex-1 bg-bg-main border border-border rounded-full px-4 py-2 text-text-primary focus:outline-none focus:border-accent transition-colors"
            autoFocus
          />
          <button
            type="submit"
            disabled={!inputText.trim()}
            className="bg-accent hover:bg-accent/90 disabled:opacity-50 text-white rounded-full p-2 w-10 h-10 flex items-center justify-center transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </form>
      </footer>
    </div>
  );
}
