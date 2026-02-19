import { Buffer } from 'buffer';
window.Buffer = Buffer;

import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { registerServiceWorker } from '@lib/serviceWorkerRegistration';
import { setAuthFailureHandler } from '@lib/api';
import { useAuthStore } from '@store/auth';


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

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

registerServiceWorker();