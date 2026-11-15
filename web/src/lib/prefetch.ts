// Prefetch chunk modul yang di-lazy-load (React.lazy + dynamic import) setelah
// user terautentikasi, supaya saat dipakai pertama kali tidak ada "blink"
// Suspense (loading screen) ataupun jeda (mis. context menu klik kanan,
// modul crop/edit, kompresi media, scan QR, panggilan WebRTC).
//
// Dipanggil dari auth store (setelah login/registrasi/bootstrap sukses) dan
// berjalan di latar belakang dengan jeda + stagger agar tidak menyenggol aksi
// user yang sedang berlangsung.

const PAGES = [
  () => import('../pages/SettingsPage'),
  () => import('../pages/ProfilePage'),
  () => import('../pages/KeyManagementPage'),
  () => import('../pages/SessionManagerPage'),
  () => import('../pages/ConnectPage'),
  () => import('../pages/AdminDashboard'),
  () => import('../pages/BurnerChat'),
];

const MODALS = [
  () => import('../components/ConfirmModal'),
  () => import('../components/UserInfoModal'),
  () => import('../components/PasswordPromptModal'),
  () => import('../components/ChatInfoModal'),
  () => import('../components/DynamicIsland'),
  () => import('../components/CommandPalette'),
  () => import('../components/ContextMenu'),
  () => import('../components/CallOverlay'),
  () => import('../components/SystemInitModal'),
  () => import('../components/SearchMessages'),
  () => import('../components/Lightbox'),
  () => import('../components/GroupInfoPanel'),
  () => import('../components/UserInfoPanel'),
  () => import('../components/OnboardingTour'),
  () => import('../components/CreateStoryModal'),
  () => import('../components/StoryViewer'),
  () => import('../components/CreateGroupChat'),
  () => import('../components/EditGroupInfoModal'),
];

const UTILITIES = [
  () => import('../lib/fileUtils'),
  () => import('../lib/webrtc'),
  () => import('../lib/opfsStorage'),
  () => import('../lib/biometricUnlock'),
  () => import('../utils/safetyNumber'),
  () => import('../utils/blobCache'),
  () => import('../utils/systemAlerts'),
  () => import('dompurify'),
  () => import('html5-qrcode'),
  () => import('@simplewebauthn/browser'),
];

let prefetched = false;

export function prefetchAppChunks(delayMs = 2000): void {
  if (prefetched) return;
  prefetched = true;

  const all = [...PAGES, ...MODALS, ...UTILITIES];

  const step = (index: number) => {
    if (index >= all.length) return;
    const batch = all.slice(index, index + 3);
    Promise.allSettled(batch.map((load) => load().catch(() => {}))).then(() => {
      const next = index + 3;
      const schedule = (cb: () => void) => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(cb, { timeout: 2000 });
        } else {
          setTimeout(cb, 400);
        }
      };
      schedule(() => step(next));
    });
  };

  const start = () => step(0);
  if (typeof requestIdleCallback === 'function') {
    // Mulai saat browser idle; pastikan tetap jalan walau tidak ada idle.
    requestIdleCallback(start, { timeout: delayMs });
  } else {
    setTimeout(start, delayMs);
  }
}
