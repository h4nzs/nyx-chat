import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useCallback } from 'react';
import { Toaster } from 'react-hot-toast';
import { FiLogOut, FiSettings } from 'react-icons/fi';
import { motion } from 'framer-motion';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import Restore from './pages/Restore';
import Chat from './pages/Chat';
import SettingsPage from './pages/SettingsPage';
import KeyManagementPage from './pages/KeyManagementPage';
import SessionManagerPage from './pages/SessionManagerPage';
import LinkDevicePage from './pages/LinkDevicePage';
import DeviceScannerPage from './pages/DeviceScannerPage';
import ProfilePage from './pages/ProfilePage';
import LandingPage from './pages/LandingPage';
import HelpPage from './pages/HelpPage'; 

// Components
import ProtectedRoute from './components/ProtectedRoute';
import ConfirmModal from './components/ConfirmModal';
import UserInfoModal from './components/UserInfoModal';
import PasswordPromptModal from './components/PasswordPromptModal';
import ChatInfoModal from './components/ChatInfoModal';
import DynamicIsland from './components/DynamicIsland';
import CommandPalette from './components/CommandPalette';

// Stores & Hooks
import { useAuthStore } from './store/auth';
import { useThemeStore } from './store/theme';
import { useCommandPaletteStore } from './store/commandPalette';
import { useConversationStore } from './store/conversation';
import { useGlobalShortcut } from './hooks/useGlobalShortcut';

// Libs & Utils
import { getSocket, connectSocket, disconnectSocket } from './lib/socket';
import { syncSessionKeys } from './utils/sessionSync';

// Variabel global untuk mencegah double-sync saat render cepat
let isSyncing = false;

// Initialize socket instance once
getSocket();

// --- Components ---

const Home = () => {
  const { conversations, loading } = useConversationStore(state => ({
    conversations: state.conversations,
    loading: state.loading,
  }));

  if (loading) {
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-bg-base text-text-primary">
        <p>Loading conversations...</p>
      </div>
    );
  }

  // Jika user punya percakapan, redirect ke yang paling terakhir/pertama
  if (conversations.length > 0) {
    return <Navigate to={`/chat/${conversations[0].id}`} replace />;
  }

  // Jika tidak ada percakapan, tampilkan halaman Chat kosong (Welcome state)
  return <Chat />;
};

const AppContent = () => {
  const { theme, accent } = useThemeStore();
  const { bootstrap, logout, user } = useAuthStore();
  const openCommandPalette = useCommandPaletteStore(s => s.open);
  const { addCommands, removeCommands } = useCommandPaletteStore(s => ({
    addCommands: s.addCommands,
    removeCommands: s.removeCommands,
  }));
  const navigate = useNavigate();
  const location = useLocation(); // <--- Tambahkan ini

  // --- Shortcuts & Commands ---
  
  const settingsAction = useCallback(() => navigate('/settings'), [navigate]);
  
  const logoutAction = useCallback(() => {
    logout();
    disconnectSocket(); // Pastikan socket putus saat logout
  }, [logout]);

  useGlobalShortcut(['Control', 'k'], openCommandPalette);
  useGlobalShortcut(['Meta', 'k'], openCommandPalette); // Support macOS Cmd+K

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

  // 1. Bootstrap Auth (Cek session saat load)
  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  // 2. Manage Socket Connection (Centralized)
  useEffect(() => {
    // Prevent global socket logic from interfering with the device linking page,
    // which manages its own guest socket connection.
    if (location.pathname.startsWith('/link-device')) {
      console.log("🔗 On Linking Page: Global socket management is paused.");
      return;
    }
    if (user) {
      console.log("👤 User authenticated, connecting socket...");
      connectSocket();
    } else {
      console.log("👤 User not authenticated, disconnecting socket...");
      disconnectSocket();
    }
  }, [user, location.pathname]);

  // 3. Sync Encryption Keys (Once per session)
  useEffect(() => {
    const sync = async () => {
      // Cek apakah user ada, belum disync di session ini, dan tidak sedang proses sync
      // FIX: Jangan jalankan sync di halaman linking device
      if (user && !location.pathname.startsWith('/link-device') && sessionStorage.getItem('keys_synced') !== 'true' && !isSyncing) {
        try {
          isSyncing = true;
          console.log("🔑 Starting session key synchronization...");
          await syncSessionKeys();
          sessionStorage.setItem('keys_synced', 'true');
          console.log("✅ Keys synced successfully.");
        } catch (error) {
          console.error("❌ Key synchronization failed:", error);
        } finally {
          isSyncing = false;
        }
      }
    };
    sync();
  }, [user, location.pathname]);

  // 4. Apply Theme
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    // Set CSS variable untuk accent color jika diperlukan oleh Tailwind/CSS
    root.style.setProperty('--color-accent', `var(--accent-${accent})`);
    root.dataset.accent = accent;
  }, [theme, accent]);

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

      <Routes>
        {/* Public Routes */}
        <Route path="/" element={
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <LandingPage />
          </motion.div>
        } />
        <Route path="/login" element={
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Login />
          </motion.div>
        } />
        <Route path="/register" element={
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Register />
          </motion.div>
        } />
        <Route path="/restore" element={
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Restore />
          </motion.div>
        } />
        <Route path="/link-device" element={
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <LinkDevicePage />
          </motion.div>
        } />
        <Route path="/help" element={
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <HelpPage />
          </motion.div>
        } />

        {/* Protected Routes (Butuh Login) */}
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Home />
            </motion.div>
          } />
          <Route path="/chat/:conversationId" element={
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Chat />
            </motion.div>
          } />

          <Route path="/settings" element={
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <SettingsPage />
            </motion.div>
          } />
          <Route path="/settings/keys" element={
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <KeyManagementPage />
            </motion.div>
          } />
          <Route path="/settings/sessions" element={
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <SessionManagerPage />
            </motion.div>
          } />
          <Route path="/settings/link-device" element={
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <DeviceScannerPage />
            </motion.div>
          } />

          <Route path="/profile/:userId" element={
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <ProfilePage />
            </motion.div>
          } />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
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