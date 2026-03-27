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

// Components
import ProtectedRoute from './components/ProtectedRoute';
const ConfirmModal = lazy(() => import('./components/ConfirmModal'));
const UserInfoModal = lazy(() => import('./components/UserInfoModal'));
const PasswordPromptModal = lazy(() => import('./components/PasswordPromptModal'));
const ChatInfoModal = lazy(() => import('./components/ChatInfoModal'));
const DynamicIsland = lazy(() => import('./components/DynamicIsland'));
const CommandPalette = lazy(() => import('./components/CommandPalette'));
const ContextMenu = lazy(() => import('./components/ContextMenu'));
const CallOverlay = lazy(() => import('./components/CallOverlay'));
const SystemInitModal = lazy(() => import('./components/SystemInitModal'));
import PrivacyCloak from './components/PrivacyCloak';
import { Spinner } from './components/Spinner';

// Stores & Hooks
import { useAuthStore } from './store/auth';
import { useThemeStore } from './store/theme';
import { useCommandPaletteStore } from './store/commandPalette';
import { useConversationStore } from './store/conversation';
import { useGlobalShortcut } from './hooks/useGlobalShortcut';
import { useShallow } from 'zustand/react/shallow';

// Libs & Utils
import { getSocket, connectSocket, disconnectSocket } from './lib/socket';
import { initWebRTCListeners } from './lib/webrtc';

// Initialize socket instance once
getSocket();

// --- Components ---

const LoadingScreen = () => (
  <div className="w-full h-screen flex items-center justify-center bg-bg-main">
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
  if (conversations.length > 0) {
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
  const { bootstrap, logout, user, isBootstrapping } = useAuthStore(useShallow(s => ({ bootstrap: s.bootstrap, logout: s.logout, user: s.user, isBootstrapping: s.isBootstrapping })));
  const openCommandPalette = useCommandPaletteStore(s => s.open);
  const { addCommands, removeCommands } = useCommandPaletteStore(useShallow(s => ({
    addCommands: s.addCommands,
    removeCommands: s.removeCommands,
  })));
  const navigate = useNavigate();
  const location = useLocation();

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
      await bootstrap();
      
      const { user, accessToken, silentRefresh, logout } = useAuthStore.getState();
      // If we think we are logged in, but we don't have an AT
      if (user && !accessToken) {
        const success = await silentRefresh();
        if (!success) {
            logout();
        }
      }
    };
    initAuth();
  }, [bootstrap]);

  // 2. Manage Socket Connection
  useEffect(() => {
    if (isDeviceFlow(location.pathname)) {
      return;
    }
    if (user) {
      const token = useAuthStore.getState().accessToken;
      if (token) {
        connectSocket();
        const socket = getSocket();
        // Safely attach WebRTC listeners immediately to the socket instance
        import('./lib/webrtc').then(({ initWebRTCListeners }) => {
          initWebRTCListeners(socket);
        });
      }
    } else {
      disconnectSocket();
    }
  }, [user, location.pathname, isDeviceFlow]);

  // 3. (Reserved for future use)

  // 4. Apply Theme
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.dataset.accent = accent;
  }, [theme, accent]);

  // 5. Visibility Change Handler
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (isDeviceFlow(location.pathname)) {
        return;
      }

      const socket = getSocket();

      if (document.visibilityState === 'visible') {
        const { user, accessToken, silentRefresh } = useAuthStore.getState();
        
        if (user && !accessToken) {
          await silentRefresh();
        }

        if (!socket?.connected) {
          if (user) {
            connectSocket();
          }
        } else {
          // Kalo socket-nya ternyata ga diputus sama OS, kita tembak event active manual
          socket.emit("user:active");
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
          socket.emit("user:away");
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

      {/* Global Modals & UI Elements */}
      <Suspense fallback={<LoadingScreen />}>
        <CommandPalette />
        <ConfirmModal />
        <UserInfoModal />
        <PasswordPromptModal />
        <ChatInfoModal />
        <DynamicIsland />
        <ContextMenu />
        <CallOverlay />
        <SystemInitModal />

        <div className="w-full h-dvh max-w-[1920px] mx-auto relative shadow-2xl overflow-hidden bg-bg-main">
          <Routes>
            {/* Public/Auth Routes */}
            {/* UBAH: Rute root "/" kini langsung melempar user ke /login jika belum auth */}
            <Route path="/" element={
              isBootstrapping ? <LoadingScreen /> : 
              user ? <Navigate to="/chat" replace /> :
              <Navigate to="/login" replace />
              }
            />
            <Route path="/login" element={
              isBootstrapping ? <LoadingScreen /> : 
              user ? <Navigate to="/chat" replace /> :
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

            {/* Fallback */}
            <Route path="*" element={<PageWrapper><NotFoundPage /></PageWrapper>} />
          </Routes>
        </div>
      </Suspense>
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
