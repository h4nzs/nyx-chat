import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useCallback, Suspense, lazy } from 'react';
import { Toaster } from 'react-hot-toast';
import { FiLogOut, FiSettings } from 'react-icons/fi';
import { motion } from 'framer-motion';

// Lazy Loaded Pages
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const Restore = lazy(() => import('./pages/Restore'));
const Chat = lazy(() => import('./pages/Chat'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const KeyManagementPage = lazy(() => import('./pages/KeyManagementPage'));
const SessionManagerPage = lazy(() => import('./pages/SessionManagerPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const LandingPage = lazy(() => import('./pages/LandingPage'));
const HelpPage = lazy(() => import('./pages/HelpPage'));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const MigrationReceivePage = lazy(() => import('./pages/MigrationReceivePage'));
const MigrationSendPage = lazy(() => import('./pages/MigrationSendPage'));

// Components
import ProtectedRoute from './components/ProtectedRoute';
import ConfirmModal from './components/ConfirmModal';
import UserInfoModal from './components/UserInfoModal';
import PasswordPromptModal from './components/PasswordPromptModal';
import ChatInfoModal from './components/ChatInfoModal';
import DynamicIsland from './components/DynamicIsland';
import CommandPalette from './components/CommandPalette';
import ContextMenu from './components/ContextMenu';
import CallOverlay from './components/CallOverlay';
import { Spinner } from './components/Spinner';

// Stores & Hooks
import { useAuthStore } from './store/auth';
import { useThemeStore } from './store/theme';
import { useCommandPaletteStore } from './store/commandPalette';
import { useConversationStore } from './store/conversation';
import { useGlobalShortcut } from './hooks/useGlobalShortcut';

// Libs & Utils
import { getSocket, connectSocket, disconnectSocket } from './lib/socket';

// Initialize socket instance once
getSocket();

// --- Components ---

const LoadingScreen = () => (
  <div className="w-full h-screen flex items-center justify-center bg-bg-main">
    <Spinner size="lg" />
  </div>
);

const Home = () => {
  const { conversations, loading } = useConversationStore(state => ({
    conversations: state.conversations,
    loading: state.loading,
  }));

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
  const { theme, accent } = useThemeStore();
  const { bootstrap, logout, user } = useAuthStore();
  const openCommandPalette = useCommandPaletteStore(s => s.open);
  const { addCommands, removeCommands } = useCommandPaletteStore(s => ({
    addCommands: s.addCommands,
    removeCommands: s.removeCommands,
  }));
  const navigate = useNavigate();
  const location = useLocation();

  // --- Shortcuts & Commands ---
  
  const settingsAction = useCallback(() => navigate('/settings'), [navigate]);
  
  const logoutAction = useCallback(() => {
    logout();
    disconnectSocket();
  }, [logout]);

  useGlobalShortcut(['Control', 'k'], openCommandPalette);
  useGlobalShortcut(['Meta', 'k'], openCommandPalette);

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
    bootstrap();
  }, [bootstrap]);

  // 2. Manage Socket Connection
  useEffect(() => {
    if (isDeviceFlow(location.pathname)) {
      return;
    }
    if (user) {
      connectSocket();
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
    root.style.setProperty('--color-accent', `var(--accent-${accent})`);
    root.dataset.accent = accent;
  }, [theme, accent]);

  // 5. Visibility Change Handler
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (isDeviceFlow(location.pathname)) {
        return;
      }

      if (document.visibilityState === 'visible') {

        const socket = getSocket();
        if (!socket?.connected) {
          if (user) {
            connectSocket();
          }
        }

        if (user) {
          useConversationStore.getState().resyncState().catch(err => {
            console.error("❌ Error during resync:", err);
          });
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
    };
  }, [user, location.pathname]);

  return (
    <>
      <Toaster
        position="top-center"
        reverseOrder={false}
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

      {/* Global Modals & UI Elements */}
      <CommandPalette />
      <ConfirmModal />
      <UserInfoModal />
      <PasswordPromptModal />
      <ChatInfoModal />
      <DynamicIsland />
      <ContextMenu />
      <CallOverlay />

      <div className="w-full h-dvh max-w-[1920px] mx-auto relative shadow-2xl overflow-hidden bg-bg-main">
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            {/* Public Routes */}
            <Route path="/" element={<PageWrapper><LandingPage /></PageWrapper>} />
            <Route path="/login" element={<PageWrapper><Login /></PageWrapper>} />
            <Route path="/register" element={<PageWrapper><Register /></PageWrapper>} />
            <Route path="/restore" element={<PageWrapper><Restore /></PageWrapper>} />
            <Route path="/migrate-receive" element={<PageWrapper><MigrationReceivePage /></PageWrapper>} />
            <Route path="/help" element={<PageWrapper><HelpPage /></PageWrapper>} />
            <Route path="/privacy" element={<PageWrapper><PrivacyPage /></PageWrapper>} />

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
            </Route>

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </div>
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
