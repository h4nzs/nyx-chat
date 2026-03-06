import { Buffer } from 'buffer';
window.Buffer = Buffer;

import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { registerServiceWorker } from '@lib/serviceWorkerRegistration';
import { setAuthFailureHandler } from '@lib/api';
import { useAuthStore } from '@store/auth';

// === TACTICAL GHOST SIGNATURE ===
// Mencetak watermark rahasia di Developer Console
if (typeof window !== 'undefined') {
  const insignia = `
  ███╗   ██╗██╗   ██╗██╗  ██╗
  ████╗  ██║╚██╗ ██╔╝╚██╗██╔╝
  ██╔██╗ ██║ ╚████╔╝  ╚███╔╝ 
  ██║╚██╗██║  ╚██╔╝   ██╔██╗ 
  ██║ ╚████║   ██║   ██╔╝ ██╗
  ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝
  
  ZERO-KNOWLEDGE MESSENGER
  Powered by NYX Core Architecture.
  License: AGPL-3.0 (Commercial Dual-License Available)
  `;

  // Sengaja pakai setTimeout biar munculnya paling akhir setelah semua log React/Vite selesai
  setTimeout(() => {
    console.log(`%c${insignia}`, "color: #00ffcc; font-family: monospace; font-weight: bold; text-shadow: 0 0 5px #00ffcc;");
    console.log("%c⚠️ SECURITY WARNING: If you are not the admin, someone might be trying to execute a Self-XSS attack. If you are an auditor, welcome to the Enigma.", "color: red; font-weight: bold; font-size: 14px;");
  }, 1000);
}

// --- Dependency Injection for Auth Failure ---
// This injects the logout function into the api layer, breaking the circular dependency.
// Now, if authFetch encounters a final token refresh failure, it can trigger a full logout.
setAuthFailureHandler(async () => {
  const { isBootstrapping, logout } = useAuthStore.getState();
  // [FIX] If we are bootstrapping (e.g. initial load or verify email page reload),
  // do NOT trigger a global logout. The bootstrap process handles its own cleanup WITHOUT wiping keys.
  if (!isBootstrapping) {
    await logout();
  }
});
// -----------------------------------------



// Validate essential environment variables on startup
if (!import.meta.env.VITE_APP_SECRET) {
  const errorMessage = "FATAL: VITE_APP_SECRET is not defined in the environment. This is required for key encryption.";
  if (import.meta.env.PROD) {
    // In production, fail fast
    throw new Error(errorMessage);
  } else {
    // In development, show a prominent warning
    alert(errorMessage);
  }
}

// Request Persistent Storage for Local Keystore
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().then(persistent => {
    if (persistent) {
      console.log("Storage will not be cleared except by explicit user action.");
    } else {
      console.warn("Storage may be cleared by the UA under storage pressure.");
    }
  });
}

import { HelmetProvider } from 'react-helmet-async';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </React.StrictMode>
);

registerServiceWorker();