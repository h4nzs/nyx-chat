import ChatList from '@components/ChatList';
import ChatWindow from '@components/ChatWindow';
import GroupInfoPanel from '@components/GroupInfoPanel';
import UserInfoPanel from '@components/UserInfoPanel';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useOrientation } from '@hooks/useOrientation';
import OnboardingTour from '@components/OnboardingTour';
import { useParams, useNavigate } from 'react-router-dom';
import ConnectionStatusBanner from '@components/ConnectionStatusBanner';

export default function Chat() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();

  const {
    activeId,
    openConversation,
    loadConversations,
    isSidebarOpen,
    conversations,
    toggleSidebar,
    loading,
    initialLoadCompleted,
  } = useConversationStore(state => ({
    activeId: state.activeId,
    openConversation: state.openConversation,
    loadConversations: state.loadConversations,
    isSidebarOpen: state.isSidebarOpen,
    conversations: state.conversations,
    toggleSidebar: state.toggleSidebar,
    loading: state.loading,
    initialLoadCompleted: state.initialLoadCompleted,
  }));

  const user = useAuthStore(state => state.user);
  const { isLandscape } = useOrientation();
  const [isTourOpen, setIsTourOpen] = useState(false);

  const activeConversation = conversations.find(c => c.id === activeId);
  const peerUser =
    user && activeConversation && !activeConversation.isGroup
      ? activeConversation.participants.find(p => p.id !== user.id)
      : null;

  // Load initial conversations
  useEffect(() => {
    if (user && !loading && !initialLoadCompleted) { // Only load if user exists, we're not loading, and initial load hasn't completed
      loadConversations();
    }
  }, [user, loading, initialLoadCompleted, loadConversations]);

  // Sync activeId from URL to store, and handle closing conversations
  useEffect(() => {
    // This handles both opening a conversation from a URL
    // and closing a conversation when navigating back to /chat
    if (conversationId !== activeId) {
      openConversation(conversationId || null);
    }
  }, [conversationId, activeId, openConversation]);

  // Check if onboarding tour needs to be shown
  useEffect(() => {
    if (user && user.hasCompletedOnboarding === false) {
      setIsTourOpen(true);
    }
  }, [user?.hasCompletedOnboarding, user]);

  const handleCloseTour = useCallback(() => {
    setIsTourOpen(false);
  }, []);

  const isDesktopLayout = window.innerWidth >= 1024 || (window.innerWidth >= 768 && isLandscape);

  return (
    <div className="h-screen w-screen flex bg-bg-main text-text-primary font-sans overflow-hidden">
      <ConnectionStatusBanner />
      <AnimatePresence>
        {isSidebarOpen && !isDesktopLayout && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={toggleSidebar} 
            className="fixed inset-0 bg-black/60 z-30 md:hidden"
          />
        )}
      </AnimatePresence>

      {/* Mobile Sidebar */}
      <AnimatePresence>
        {isSidebarOpen && !isDesktopLayout && (
          <motion.aside 
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="absolute md:hidden w-full max-w-sm h-full bg-bg-surface flex flex-col border-r border-border z-40"
          >
            <ChatList />
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Desktop Sidebar (Left) */}
      {isDesktopLayout && (
        <aside className="hidden md:absolute md:top-0 md:left-0 md:flex w-full max-w-sm md:w-1/3 lg:w-1/4 2xl:w-1/5 h-full bg-bg-surface flex-col z-10 shadow-neumorphic-convex">
          <ChatList />
        </aside>
      )}

      <main className={`w-full flex-1 flex flex-col h-full ${isDesktopLayout ? 'md:pl-[33.333333%] lg:pl-[25%] 2xl:pl-[20%]' : ''}`}>
        {activeId && activeConversation ? (
          <ChatWindow key={activeId} id={activeId} onMenuClick={toggleSidebar} />
        ) : (
          <div className="flex-1 flex flex-col h-full">
            {/* Mobile-only header with toggle */}
            {!isDesktopLayout && (
              <div className="md:hidden p-4 border-b border-border flex items-center flex-shrink-0">
                <button onClick={toggleSidebar} className="touch-target p-2.5 text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                </button>
                <p className="ml-4 font-semibold">Conversations</p>
              </div>
            )}

            {/* Placeholder Content */}
            <div className="flex-1 flex flex-col gap-4 items-center justify-center text-text-secondary p-4">
              <div className="p-6 rounded-full bg-bg-surface shadow-neumorphic-convex">
                <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-70"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <p className="text-lg font-medium">Select a conversation to start messaging</p>
            </div>
          </div>
        )}
      </main>

      {/* Command Center Panel (Right) */}
      <AnimatePresence>
        {activeId && activeConversation && isDesktopLayout && (
           <motion.aside 
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="hidden 2xl:flex 2xl:w-1/4 h-full bg-bg-surface flex-col border-l border-border"
          >
            {activeConversation.isGroup ? (
              <GroupInfoPanel conversationId={activeId} onClose={() => {}} />
            ) : ( peerUser && 
              <UserInfoPanel userId={peerUser.id} />
            )}
          </motion.aside>
        )}
      </AnimatePresence>

      <OnboardingTour isOpen={isTourOpen} onClose={handleCloseTour} />
    </div>
  );
}