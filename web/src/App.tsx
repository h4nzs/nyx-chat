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
// [LINK 2026-10-18] Halaman perangkat baru yang memindai QR dari perangkat lama.
const LinkDevicePage = lazy(() => import('./pages/LinkDevicePage'));
// [docs/35 residual] Harness benchmark perangkat; isinya menolak jalan kecuali
// build dev / VITE_PQ_BENCH=1, jadi route ini aman ada di bundle default.
const PqDeviceBenchPage = lazy(() => import('./pages/PqDeviceBenchPage'));
const UsernameLinkPage = lazy(() => import('./pages/UsernameLinkPage'));
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
import { ServerDownPage } from './pages/ServerDownPage'; // statis (bukan lazy): harus bisa tampil saat server mati
import { reportKtAvailable, reportKtUnavailable } from './lib/ktAvailability';

const ConfirmModal = lazy(() => import('@components/ConfirmModal'));
const UserInfoModal = lazy(() => import('@components/UserInfoModal'));
const PasswordPromptModal = lazy(() => import('@components/PasswordPromptModal'));
const ChatInfoModal = lazy(() => import('@components/ChatInfoModal'));
const DynamicIsland = lazy(() => import('@components/DynamicIsland'));
const CommandPalette = lazy(() => import('@components/CommandPalette'));
const ContextMenu = lazy(() => import('@components/ContextMenu'));
const CallOverlay = lazy(() => import('@components/CallOverlay'));
const SystemInitModal = lazy(() => import('@components/SystemInitModal'));

// [MODAL-PRELOAD] Preload semua chunk modal saat idle agar Suspense tidak pernah
// suspend di jalur normal — chunk sudah di-cache jauh sebelum modal pertama dibuka.
preloadOnIdle([
  () => import('@components/ConfirmModal'),
  () => import('@components/UserInfoModal'),
  () => import('@components/PasswordPromptModal'),
  () => import('@components/ChatInfoModal'),
  () => import('@components/DynamicIsland'),
  () => import('@components/CommandPalette'),
  () => import('@components/ContextMenu'),
  () => import('@components/CallOverlay'),
  () => import('@components/SystemInitModal'),
]);

/**
 * [MODAL-SUSPENSE] Boundary per-modal dengan fallback={null}.
 * KERUSAKAN YANG DIHINDARI: sebelumnya SEMUA modal + seluruh routes berada di
 * SATU Suspense dengan fallback LoadingScreen full-screen — membuka modal yang
 * chunk-nya belum ada menggantikan SELURUH aplikasi dengan spinner (blink
 * "seperti refresh DOM", terutama saat klik kanan pertama → ContextMenu).
 * Kini setiap modal punya boundary sendiri; jika suspend, HANYA modal itu yang
 * belum tampil — aplikasi di sekelilingnya tidak pernah terganggu. Ditambah
 * preload on-idle di atas, suspend praktis tak pernah terjadi.
 */
const ModalSuspense = ({ children }: { children: React.ReactNode }) => (
  <Suspense fallback={null}>{children}</Suspense>
);

// Stores & Hooks
import { useAuthStore } from './store/auth';
import { useThemeStore } from './store/theme';
import { useCommandPaletteStore } from './store/commandPalette';
import { useModalStore } from './store/modal';
import { useContextMenuStore } from './store/contextMenu';
import { preloadOnIdle } from '@utils/modalPreload';
import i18n from './i18n';
import { useCallStore } from './store/callStore';
import { useConversationStore } from './store/conversation';
import { useSystemStore } from './store/systemStore';
import { useGlobalShortcut } from './hooks/useGlobalShortcut';
import { useShallow } from 'zustand/react/shallow';

// Libs & Utils
import { transportClient, connectSocket, disconnectSocket } from './lib/transportClient';
import { initSocketListeners } from './lib/socketListeners';

// [LINT 2026-10-11] Baris `transportClient;` dihapus: pernyataan kosong tanpa
// efek (modul sudah di-import di atas, singleton dibuat saat import).
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
  const { maintenance, serverUnreachable, checkStatus } = useSystemStore(useShallow(s => ({
    maintenance: s.maintenance,
    serverUnreachable: s.serverUnreachable,
    checkStatus: s.checkStatus
  })));

  useEffect(() => {
    checkStatus();
    // Polling setiap 60 detik
    const interval = setInterval(checkStatus, 60000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  // --- [T4] Cover traffic scheduler (doc 26.10) ---
  // Client-local: server TIDAK boleh tahu percakapan mana yang menjalankan
  // cover — toggle disimpan lokal (settings store), timer disinkronkan dengan
  // daftar grup "Maximum" milik klien ini saja.
  useEffect(() => {
    if (!user) return;
    let mounted = true;
    Promise.all([
      import('@lib/coverTraffic'),
      import('@store/message'),
      import('@store/connection'),
      import('@store/settings'),
    ]).then(async ([cover, msgStore, connStore, settingsMod]) => {
      if (!mounted) return;
      const scheduler = cover.getCoverScheduler((conversationId) => {
        msgStore.useMessageStore.getState().sendCoverTraffic(conversationId);
      });
      scheduler.updatePreferences({
        isTransportConnected: () => connStore.useConnectionStore.getState().status === 'connected',
      });
      const { coverTrafficMaximumGroups, coverTrafficMasterEnabled } = settingsMod.useSettingsStore.getState();
      scheduler.updatePreferences({ masterEnabled: coverTrafficMasterEnabled, maximumGroups: new Set(coverTrafficMaximumGroups) });
      // [26.10.5 Q5] Burner default Maximum: gabungkan grup Maximum eksplisit
      // dengan semua burner yang diketahui conversation store, dan ikuti
      // perubahannya live (burner baru/pulih otomatis ter-arm). Snapshot grup
      // Maximum di-refresh tiap callback agar perubahan toggle terbaca.
      const convMod = await import('@store/conversation');
      const armFromStore = () => {
        const { coverTrafficMaximumGroups: currentMax } = settingsMod.useSettingsStore.getState();
        scheduler.updatePreferences({ maximumGroups: new Set(currentMax) });
        const { conversations } = convMod.useConversationStore.getState();
        scheduler.sync(cover.collectCoverArmedIds(currentMax, conversations));
      };
      armFromStore();
      convMod.useConversationStore.subscribe(armFromStore);
    }).catch(e => console.warn('[T4] Cover scheduler init failed:', e));
    return () => { mounted = false; };
  }, [user]);

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
      // [BURNER GUEST] Halaman /drop TIDAK punya sesi akun: identitas guest
      // dibuat BurnerChat lewat `POST /api/auth/burner` sesaat setelah mount.
      // Bootstrap store di sini BALAPAN dengan itu — refresh guest memang gagal
      // (token ephemeral), lalu fallback `GET /api/users/me` 401 dan jalur catch
      // bootstrap MEMBERSIHKAN cookie `at` + `user` yang baru diterbitkan.
      // Akibatnya uplink burner turun, identitas guest berganti, dan balasan host
      // (`burner:reply` hanya di-relay ke anggota room) tidak pernah sampai.
      if (window.location.pathname === '/drop') {
        useAuthStore.setState({ isBootstrapping: false });
        return;
      }
      try {
        await bootstrap();
        
        const { user, accessToken, silentRefresh, logout } = useAuthStore.getState();
        // [BURNER GUEST] Guest tidak bisa di-refresh (token ephemeral) — jangan
        // pernah panggil logout() untuk mereka: logout menghapus cookie sesi yang
        // masih sah dan mematikan uplink burner yang sedang berjalan.
        const isGuest = user?.role === 'GUEST' || user?.id?.startsWith('guest_');
        // If we think we are logged in, but we don't have an AT
        if (user && !accessToken && !isGuest) {
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

  // 2b. [docs/34 §34.5] Loop monitor Key Transparency.
  //
  // Kenapa di app shell dan bukan di store kripto: langkah monitor adalah
  // pekerjaan latar yang hanya masuk akal selama sesi terautentikasi dengan
  // vault terbuka (`hasRestoredKeys`) — dan modul WASM-nya 295 KiB, jadi impor
  // dinamis di sini menjaga bundel awal tetap tanpa KT.
  useEffect(() => {
    if (!user || !hasRestoredKeys) return;

    let cancelled = false;
    let stop: (() => void) | undefined;
    let stopGossipListener: (() => void) | undefined;

    // [docs/30 §30.5 tahap C] Jangkar gossip dimuat lebih dulu: jalur kirim
    // menyisipkan `ktG` ke payload ter-seal, dan setelah reload cache RAM kosong
    // sampai langkah monitor pertama (30 s). Memuat jangkar tersimpan di sini
    // membuat pesan pertama sesi tetap membawa gossip.
    void (async () => {
      try {
        const { loadStoredAnchor, onKtSplitView } = await import('@lib/ktGossip');
        await loadStoredAnchor();
        if (cancelled) return;
        stopGossipListener = onKtSplitView((record) => {
          // Split-view: dua klien melihat root BERBEDA untuk ukuran pohon yang
          // SAMA. Tidak ada penjelasan sah untuk itu (`docs/30` §30.5) — ini
          // peringatan, bukan blokir: keputusan blokir tetap milik pin identitas.
          console.warn('[KT] Split-view tree head terdeteksi:', record);
          toast(i18n.t('chat:banners.kt_split_view', {
            defaultValue:
              'Key Transparency: two clients saw different tree heads for the same tree size. This should never happen — verify your contacts.',
          }), { icon: '⚠️', duration: 10000 });
        });
      } catch (error) {
        console.warn('[KT] Jangkar gossip tidak bisa dimuat:', error);
      }
    })();

    void (async () => {
      try {
        const [{ startKtMonitorLoop }, { monitorKeyTransparency }] = await Promise.all([
          import('@lib/ktMonitoring'),
          import('@lib/ktBundleProof'),
        ]);
        if (cancelled) return;
        stop = startKtMonitorLoop({
          run: async () => {
            try {
              const outcome = await monitorKeyTransparency();
              reportKtAvailable();
              return outcome;
            } catch (error) {
              reportKtUnavailable(error);
              throw error;
            }
          },
          onChanged: (changes) => {
            // Kenaikan `keyVersion` di log = kandidat rotasi kunci; pesan yang
            // datang dari kunci lama akan tampil `keyVersion` lama + terdeteksi
            // oleh pin identitas (`docs/34` §34.6 poin 1).
            toast(i18n.t('chat:banners.kt_key_rotation', {
              count: changes.length,
              defaultValue: 'Key Transparency: a contact key rotation was published in the log.',
            }), { icon: '🔐', duration: 6000 });
          },
          onError: (error) => {
            console.warn('[KT] Langkah monitor gagal (loop tetap berjalan):', error);
          },
        });
      } catch (error) {
        console.warn('[KT] Loop monitor tidak bisa dimulai:', error);
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
      stopGossipListener?.();
    };
  }, [user, hasRestoredKeys]);

  // 2c. [docs/37 §37.3.6] Rotasi era grup terjadwal (PCS kasar tanpa MLS).
  //
  // Hanya grup tempat kita admin yang benar-benar berputar (dicek di dalam),
  // dan rotasi memakan bandwidth (metadata + distribusi kunci), jadi jadwalnya
  // 15 menit dengan jeda awal 2 menit — bukan tiap tick mailbox.
  useEffect(() => {
    if (!user || !hasRestoredKeys) return;

    let cancelled = false;
    let stop: (() => void) | undefined;
    void (async () => {
      try {
        const { startGroupEpochLoop } = await import('@lib/groupEpochRotation');
        if (cancelled) return;
        stop = startGroupEpochLoop();
      } catch (error) {
        console.warn('[Epoch] Loop rotasi era grup tidak bisa dimulai:', error);
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [user, hasRestoredKeys]);

  // 2d. [docs/37 §37.3.2] Poll mailbox grup (distribusi kunci tanpa graf).
  //
  // Envelope kunci grup sekarang ditulis ke mailbox percakapan, bukan direlai
  // `group:fulfilled_key` (yang membocorkan requester→fulfiller + menyimpan
  // `targetDeviceKey`). Tanpa poll ini kunci baru tidak akan pernah sampai ke
  // anggota lain — jadi loop ini bagian dari jalur kirim, bukan pelengkap.
  useEffect(() => {
    if (!user || !hasRestoredKeys) return;

    let cancelled = false;
    let stop: (() => void) | undefined;
    void (async () => {
      try {
        const { startGroupMailboxLoop } = await import('@lib/groupMailbox');
        if (cancelled) return;
        stop = startGroupMailboxLoop();
      } catch (error) {
        console.warn('[Mailbox] Loop mailbox grup tidak bisa dimulai:', error);
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [user, hasRestoredKeys]);
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
  // Server tak terjangkau menang atas flag maintenance lama (flag itu bisa basi).
  if (maintenance && !serverUnreachable) {
    return <MaintenancePage onRetry={checkStatus} />;
  }

  return (
    <>
      {/* Overlay server-down: app tetap ter-mount di bawahnya (state tidak hilang). */}
      {serverUnreachable && <ServerDownPage onRetry={checkStatus} />}
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
        {/* [MODAL-SUSPENSE] Setiap modal di boundary sendiri (fallback={null}):
            suspend modal tidak pernah mengganggu app di sekelilingnya — dulu
            SEMUA modal + routes berada di SATU boundary ber-fallback
            LoadingScreen full-screen, sehingga membuka modal yang chunk-nya
            belum ada menggantikan SELURUH aplikasi (blink "refresh DOM"). */}
        <ModalSuspense>
          {/* CommandPalette wajib selalu ter-mount: dia mendaftarkan command
              navigasi global di dalam dirinya */}
          <CommandPalette />
        </ModalSuspense>
        <ModalSuspense>{isConfirmOpen && <ConfirmModal />}</ModalSuspense>
        <ModalSuspense>{isProfileModalOpen && <UserInfoModal />}</ModalSuspense>
        <ModalSuspense>{isPasswordPromptOpen && <PasswordPromptModal />}</ModalSuspense>
        <ModalSuspense>{isChatInfoModalOpen && <ChatInfoModal />}</ModalSuspense>
        <ModalSuspense>
          <DynamicIsland />
        </ModalSuspense>
        <ModalSuspense>{isContextMenuOpen && <ContextMenu />}</ModalSuspense>
        <ModalSuspense>{isCallActive && <CallOverlay />}</ModalSuspense>
        <ModalSuspense>
          <SystemInitModal />
        </ModalSuspense>

        {/* [MODAL-SUSPENSE] Boundary untuk routes: hanya halaman lazy yang
            suspend di sini (fallback per-navigasi, bukan per-modal). */}
        <Suspense fallback={<LoadingScreen />}>
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
              {/* [LINK 2026-10-18] Publik: perangkat baru belum punya sesi. */}
              <Route path="/link" element={<PageWrapper><LinkDevicePage /></PageWrapper>} />
              <Route path="/migrate-receive" element={<PageWrapper><MigrationReceivePage /></PageWrapper>} />
              {/* [docs/35 residual] Benchmark perangkat: publik supaya HP bisa
                  membuka tanpa sesi; nonaktif pada build default. */}
              <Route path="/bench/pq" element={<PageWrapper><PqDeviceBenchPage /></PageWrapper>} />
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
                {/* [docs/30 WS-I] link pendek /u/<hashId> → alur connect */}
                <Route path="/u/:hashId" element={<PageWrapper><UsernameLinkPage /></PageWrapper>} />
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
