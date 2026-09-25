// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useCallback, Suspense, lazy } from 'react';
import { Toaster, useToasterStore, toast } from 'react-hot-toast';
import { FiLogOut, FiSettings } from 'react-icons/fi';
import { motion } from 'framer-motion';

// Lazy Loaded Pages (DIBERSIHKAN: LandingPage, HelpPage, PrivacyPage dihapus)
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const Restore = lazy(() => import('./pages/Restore'));
const Chat = lazy(() => import('./pages/Chat'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const KeyManagementPage = lazy(() => import('./pages/KeyManagementPage'));
const SessionManagerPage = lazy(() => import('./pages/SessionManagerPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const MigrationReceivePage = lazy(() => import('./pages/MigrationReceivePage'));
const MigrationSendPage = lazy(() => import('./pages/MigrationSendPage'));
const ConnectPage = lazy(() => import('./pages/ConnectPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const BurnerChat = lazy(() => import('./pages/BurnerChat'));
const EmbedChatPage = lazy(() => import('./pages/EmbedChatPage'));

// Components — modal global di-LAZY (hanya diunduh & dimount saat dibutuhkan).
// Sebelumnya eager import membengkakkan main bundle (CallOverlay, CommandPalette, dll).
import ProtectedRoute from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import PrivacyCloak from './components/PrivacyCloak';
import { Spinner } from './components/Spinner';
import { SystemBanner } from './components/SystemBanner';
import { MaintenancePage } from './pages/MaintenancePage';

const ConfirmModal = lazy(() => import('@components/ConfirmModal'));
const UserInfoModal = lazy(() => import('@components/UserInfoModal'));
const PasswordPromptModal = lazy(() => import('@components/PasswordPromptModal'));
const ChatInfoModal = lazy(() => import('@components/ChatInfoModal'));
const DynamicIsland = lazy(() => import('@components/DynamicIsland'));
const CommandPalette = lazy(() => import('@components/CommandPalette'));
// [NO-LAZY] ContextMenu HARUS eager: klik kanan pertama memicu chunk download
// → Suspense fallback (LoadingScreen full-screen) menggantikan SELURUH UI
// aplikasi selama fetch → terlihat seperti blink/refresh DOM. Chunk kecil
// (emoji picker di dalamnya sudah di-lazy sendiri) tidak berdampak ke bundle.
import ContextMenu from '@components/ContextMenu';
const CallOverlay = lazy(() => import('@components/CallOverlay'));
const SystemInitModal = lazy(() => import('@components/SystemInitModal'));

// Stores & Hooks
import { useAuthStore } from './store/auth';
import { useThemeStore } from './store/theme';
import { useCommandPaletteStore } from './store/commandPalette';
import { useModalStore } from './store/modal';
import { useContextMenuStore } from './store/contextMenu';
import { useCallStore } from './store/callStore';
import { useConversationStore } from './store/conversation';
import { useSystemStore } from './store/systemStore';
import { useGlobalShortcut } from './hooks/useGlobalShortcut';
import { useShallow } from 'zustand/react/shallow';

// Libs & Utils
import { transportClient, connectSocket, disconnectSocket } from './lib/transportClient';
import { initSocketListeners } from './lib/socketListeners';

// Initialize socket instance once
transportClient;
initSocketListeners();

// --- Components ---

const LoadingScreen = () => (
  <div className="w-full h-dvh flex items-center justify-center bg-bg-main">
    <Spinner size="lg" />
  </div>
);

const Home = () => {
  const { conversations, loading } = useConversationStore(useShallow(state => ({
    conversations: state.conversations,
    loading: state.loading,
  })));

  if (loading) {
    return <LoadingScreen />;
  }

  // Jika user punya percakapan, redirect ke yang paling terakhir/pertama
  if (conversations.length > 0 && conversations[0]) {
    return <Navigate to={`/chat/${conversations[0].id}`} replace />;
  }

  // Jika tidak ada percakapan, tampilkan halaman Chat kosong (Welcome state)
  return <Chat />;
};

const PageWrapper = ({ children, noScroll = false }: { children: React.ReactNode, noScroll?: boolean }) => (
  <motion.div
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.3 }}
    className={noScroll ? "h-full w-full overflow-hidden" : "h-full w-full overflow-y-auto"}
  >
    {children}
  </motion.div>
);

const AppContent = () => {
  const { theme, accent } = useThemeStore(useShallow(s => ({ theme: s.theme, accent: s.accent })));
  const { bootstrap, logout, user, isBootstrapping, hasRestoredKeys } = useAuthStore(useShallow(s => ({ 
    bootstrap: s.bootstrap, 
    logout: s.logout, 
    user: s.user, 
    isBootstrapping: s.isBootstrapping,
    hasRestoredKeys: s.hasRestoredKeys
  })));
  const openCommandPalette = useCommandPaletteStore(s => s.open);
  const { addCommands, removeCommands } = useCommandPaletteStore(useShallow(s => ({
    addCommands: s.addCommands,
    removeCommands: s.removeCommands,
  })));
  const navigate = useNavigate();
  const location = useLocation();

  // --- Kondisi render modal global (on-demand chunk loading) ---
  const { isConfirmOpen, isProfileModalOpen, isPasswordPromptOpen, isChatInfoModalOpen } = useModalStore(useShallow(s => ({
    isConfirmOpen: s.isConfirmOpen,
    isProfileModalOpen: s.isProfileModalOpen,
    isPasswordPromptOpen: s.isPasswordPromptOpen,
    isChatInfoModalOpen: s.isChatInfoModalOpen
  })));
  const isContextMenuOpen = useContextMenuStore(s => s.isOpen);
  const isCallActive = useCallStore(s => s.callState !== 'idle');

  // --- System Status (Banner & Maintenance) ---
  const { maintenance, checkStatus } = useSystemStore(useShallow(s => ({
    maintenance: s.maintenance,
    checkStatus: s.checkStatus
  })));

  useEffect(() => {
    checkStatus();
    // Polling setiap 60 detik
    const interval = setInterval(checkStatus, 60000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  // --- Service Worker SPA Routing ---
  useEffect(() => {
    const handleSwMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'PWA_ROUTER_NAVIGATE') {
        console.log('[App] Received navigation command from SW:', event.data.url);
        navigate(event.data.url);
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSwMessage);
    }

    return () => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleSwMessage);
      }
    };
  }, [navigate]);

  // --- Shortcuts & Commands ---
  
  const settingsAction = useCallback(() => navigate('/settings'), [navigate]);
  
  const logoutAction = useCallback(() => {
    logout();
    disconnectSocket();
  }, [logout]);

  useGlobalShortcut(['Control', 'k'], openCommandPalette);
  useGlobalShortcut(['Meta', 'k'], openCommandPalette);

  // --- Toast Limiter ---
  const { toasts } = useToasterStore();
  const MAX_TOASTS = 3;

  useEffect(() => {
    toasts
      .filter((t) => t.visible) // Only consider visible toasts
      .filter((_, i) => i >= MAX_TOASTS) // Get toasts beyond the limit
      .forEach((t) => { toast.dismiss(t.id); }); // Dismiss them
  }, [toasts]);

  useEffect(() => {
    const commands = [
      {
        id: 'settings',
        name: 'Settings',
        action: settingsAction,
        icon: <FiSettings />,
        section: 'Navigation',
        keywords: 'preferences options configuration',
      },
      {
        id: 'logout',
        name: 'Logout',
        action: logoutAction,
        icon: <FiLogOut />,
        section: 'General',
        keywords: 'sign out exit leave',
      },
    ];
    addCommands(commands);
    return () => removeCommands(commands.map(c => c.id));
  }, [addCommands, removeCommands, settingsAction, logoutAction]);

  // --- Lifecycle & Effects ---

  const isDeviceFlow = useCallback((pathname: string) => {
      return pathname.startsWith('/link-device') || pathname.startsWith('/migrate-receive');
  }, []);

  // 1. Bootstrap Auth
  useEffect(() => {
    const initAuth = async () => {
      try {
        await bootstrap();
        
        const { user, accessToken, silentRefresh, logout } = useAuthStore.getState();
        // If we think we are logged in, but we don't have an AT
        if (user && !accessToken) {
          const success = await silentRefresh();
          if (!success) {
              logout();
          }
        }
      } catch (e) {
        console.log("Bootstrap error (normal for guests):", e);
      }
    };
    initAuth();
  }, [bootstrap]);

  // 2. Manage Socket Connection
  useEffect(() => {
    if (isDeviceFlow(location.pathname)) {
      return;
    }
    if (user && useAuthStore.getState().hasRestoredKeys) {
      const token = useAuthStore.getState().accessToken;
      if (token) {
        connectSocket();
        const socket = transportClient;
        // Safely attach WebRTC listeners immediately to the socket instance
        import('./lib/webrtc').then(({ initWebRTCListeners }) => {
          initWebRTCListeners();
        });
      }
    } else {
      // Don't disconnect if on Burner Chat drop route (guest needs it)
      // or if on a device flow route that requires the socket for migration
      if (location.pathname !== '/drop' && !isDeviceFlow(location.pathname)) {
         disconnectSocket();
      }
    }
  }, [user, location.pathname, isDeviceFlow]);

  // 3. Apply Theme
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.dataset.accent = accent;
  }, [theme, accent]);

  // 4. Visibility Change Handler
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (isDeviceFlow(location.pathname)) {
        return;
      }

      const socket = transportClient;

      if (document.visibilityState === 'visible') {
        const { user, accessToken, silentRefresh } = useAuthStore.getState();
        
        if (user && !accessToken) {
          await silentRefresh();
        }

        // If the app was locked in the background, we need to prompt the user.
        // `hasRestoredKeys` will be false, so the UI will naturally prompt them
        // if they try to read messages or if we trigger the auth check here.

        if (!socket?.connected) {
          if (user && useAuthStore.getState().hasRestoredKeys) {
            connectSocket();
          }
        } else {
          // Kalo socket-nya ternyata ga diputus sama OS, kita tembak event active manual
          transportClient.sendEvent("user:active");
        }

        if (user) {
          useConversationStore.getState().resyncState().catch(err => {
            console.error("❌ Error during resync:", err);
          });
        }
      }
      else if (document.visibilityState === 'hidden') {
        if (socket?.connected) {
          // Kasih tau server kalau user lagi minimize app/pindah tab/kunci layar
          transportClient.sendEvent("user:away");
        }

        // --- AUTH LOCK (Cryptographic Wipe) ---
        // If the user has Privacy Cloak enabled, we also wipe the keys from RAM and sessionStorage.
        const { privacyCloak } = await import('./store/settings').then(m => m.useSettingsStore.getState());
        
        // Re-check visibility state after the async import to prevent race conditions
        if (privacyCloak && document.visibilityState === 'hidden') {
           useAuthStore.getState().lockApp();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
    };
  }, [user, location.pathname, isDeviceFlow]);

  // --- CEGAT RENDER JIKA MODE MAINTENANCE AKTIF ---
  if (maintenance) {
    return <MaintenancePage onRetry={checkStatus} />;
  }

  return (
    <>
      <Toaster
        position="top-center"
        reverseOrder={false}
        containerStyle={{ zIndex: 99999 }}
        toastOptions={{
          duration: 5000,
          className: 'glass-toast',
          style: {
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-convex)',
          },
          success: {
            duration: 3000,
            iconTheme: {
              primary: 'var(--color-accent, #3b82f6)',
              secondary: '#fff',
            },
          },
          error: {
            iconTheme: {
              primary: '#ef4444',
              secondary: '#fff',
            },
          },
        }}
      />

      <PrivacyCloak />

      {/* Global Modals & UI Elements — render on-demand agar chunk modal
          hanya diunduh saat benar-benar dibutuhkan */}
      <ErrorBoundary>
      <Suspense fallback={<LoadingScreen />}>
        {/* CommandPalette wajib selalu ter-mount: dia mendaftarkan command
            navigasi global di dalam dirinya */}
        <CommandPalette />
        {isConfirmOpen && <ConfirmModal />}
        {isProfileModalOpen && <UserInfoModal />}
        {isPasswordPromptOpen && <PasswordPromptModal />}
        {isChatInfoModalOpen && <ChatInfoModal />}
        <DynamicIsland />
        {isContextMenuOpen && <ContextMenu />}
        {isCallActive && <CallOverlay />}
        <SystemInitModal />

        <div className="w-full h-dvh max-w-[1920px] mx-auto relative shadow-2xl overflow-hidden bg-bg-main flex flex-col">
          {/* Banner Status Sistem */}
          <SystemBanner />

          {/* Area Konten Aplikasi Utama */}
          <div className="flex-1 w-full overflow-hidden relative">
            <Routes>
              {/* Public/Auth Routes */}
              <Route path="/" element={
                isBootstrapping ? <LoadingScreen /> : 
                (user && hasRestoredKeys) ? <Navigate to="/chat" replace /> :
                <Navigate to="/login" replace />
                }
              />
              <Route path="/login" element={
                isBootstrapping ? <LoadingScreen /> : 
                (user && hasRestoredKeys) ? <Navigate to="/chat" replace /> :
                <PageWrapper><Login /></PageWrapper>
                }
              />
              <Route path="/register" element={
                isBootstrapping ? <LoadingScreen /> :
                <PageWrapper><Register /></PageWrapper>
                }
              />
              <Route path="/restore" element={<PageWrapper><Restore /></PageWrapper>} />
              <Route path="/migrate-receive" element={<PageWrapper><MigrationReceivePage /></PageWrapper>} />
              <Route path="/drop" element={<PageWrapper noScroll={true}><BurnerChat /></PageWrapper>} />

              {/* Protected Routes */}
              <Route element={<ProtectedRoute />}>
                <Route path="/chat" element={<PageWrapper noScroll={true}><Home /></PageWrapper>} />
                <Route path="/chat/:conversationId" element={<PageWrapper noScroll={true}><Chat /></PageWrapper>} />

                <Route path="/settings" element={<PageWrapper><SettingsPage /></PageWrapper>} />
                <Route path="/settings/keys" element={<PageWrapper><KeyManagementPage /></PageWrapper>} />
                <Route path="/settings/sessions" element={<PageWrapper><SessionManagerPage /></PageWrapper>} />
                <Route path="/settings/migrate-send" element={<PageWrapper><MigrationSendPage /></PageWrapper>} />
                <Route path="/admin-console" element={<PageWrapper><AdminDashboard /></PageWrapper>} />

                <Route path="/profile/:userId" element={<PageWrapper><ProfilePage /></PageWrapper>} />
                <Route path="/connect" element={<PageWrapper><ConnectPage /></PageWrapper>} />
              </Route>

              {/* Embed Route (No Layout/Sidebar) */}
              <Route path="/embed/chat/:id" element={<EmbedChatPage />} />

              {/* Fallback */}
              <Route path="*" element={<PageWrapper><NotFoundPage /></PageWrapper>} />
            </Routes>
          </div>
        </div>
      </Suspense>
      </ErrorBoundary>
    </>
  );
};

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
