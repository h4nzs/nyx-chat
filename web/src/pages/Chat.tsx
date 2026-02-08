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
import { FiMessageSquare } from 'react-icons/fi';

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
    if (user && !loading && !initialLoadCompleted) { 
      loadConversations();
    }
  }, [user, loading, initialLoadCompleted, loadConversations]);

  // Sync activeId from URL
  useEffect(() => {
    if (conversationId !== activeId) {
      openConversation(conversationId || null);
    }
  }, [conversationId, activeId, openConversation]);

  // Onboarding
  const isBootstrapping = useAuthStore(state => state.isBootstrapping);
  useEffect(() => {
    if (user && !isBootstrapping && user.hasCompletedOnboarding === false) {
      setIsTourOpen(true);
    }
  }, [user?.hasCompletedOnboarding, user, isBootstrapping]);

  const handleCloseTour = useCallback(() => setIsTourOpen(false), []);
  const isDesktopLayout = window.innerWidth >= 1024 || (window.innerWidth >= 768 && isLandscape);

  return (
    <div className="h-screen w-screen flex bg-bg-main text-text-primary font-sans overflow-hidden">
      <ConnectionStatusBanner />
      
      {/* Mobile Sidebar Overlay */}
      <AnimatePresence>
        {isSidebarOpen && !isDesktopLayout && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={toggleSidebar} 
            className="fixed inset-0 bg-black/60 z-30 md:hidden backdrop-blur-sm"
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
            className="fixed inset-y-0 left-0 w-[85%] max-w-sm bg-bg-main border-r border-white/10 z-40 shadow-2xl"
          >
            <ChatList />
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Desktop Sidebar (Left) */}
      {isDesktopLayout && (
        <aside className="
          relative z-20 h-full 
          w-1/3 lg:w-1/4 2xl:w-1/5 
          bg-bg-main border-r border-white/10 dark:border-black/10
          shadow-neu-flat-light dark:shadow-neu-flat-dark
        ">
          <ChatList />
        </aside>
      )}

      {/* Main Terminal Area */}
      <main className="flex-1 flex flex-col h-full min-w-0 bg-bg-main relative z-10">
        {activeId && activeConversation ? (
          <ChatWindow key={activeId} id={activeId} onMenuClick={toggleSidebar} />
        ) : (
          <div className="flex-1 flex flex-col h-full relative">
            {/* Screen Bezel Shadow */}
            <div className="absolute inset-0 shadow-neumorphic-pressed-light dark:shadow-neu-pressed-dark pointer-events-none"></div>

            {/* Mobile-only toggle header */}
            {!isDesktopLayout && (
              <div className="md:hidden p-4 flex items-center flex-shrink-0 z-20">
                <button 
                  onClick={toggleSidebar} 
                  className="
                    p-3 rounded-xl text-text-secondary bg-bg-main
                    shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm 
                    transition-all
                  "
                >
                   <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                </button>
              </div>
            )}

            {/* Placeholder Empty State */}
            <div className="flex-1 flex flex-col items-center justify-center text-text-secondary p-8 opacity-50">
              <div className="p-8 rounded-full bg-bg-surface shadow-neumorphic-convex mb-6">
                <FiMessageSquare size={64} className="opacity-50" />
              </div>
              <h2 className="text-2xl font-black uppercase tracking-widest mb-2">System Ready</h2>
              <p className="font-mono text-sm">Select a frequency to begin transmission.</p>
            </div>
          </div>
        )}
      </main>

      {/* Info Panel (Right) - Desktop Only */}
      <AnimatePresence>
        {activeId && activeConversation && isDesktopLayout && (
           <motion.aside 
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="
              hidden 2xl:flex w-1/4 h-full 
              bg-bg-main border-l border-white/10 dark:border-black/10
              shadow-[-5px_0_15px_rgba(0,0,0,0.05)] z-20
            "
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