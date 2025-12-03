import { Buffer } from 'buffer';
window.Buffer = Buffer;

import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { registerServiceWorker } from '@lib/serviceWorkerRegistration';

// Validate essential environment variables on startup
if (!import.meta.env.VITE_APP_SECRET) {
  const errorMessage = "FATAL: VITE_APP_SECRET is not defined in the environment. This is required for key encryption.";
  if (import.meta.env.PROD) {
    // In production, fail fast
    throw new Error(errorMessage);
  } else {
    // In development, show a prominent warning
    console.warn(`%c${errorMessage}`, 'color: red; font-size: 1.5em; font-weight: bold;');
    alert(errorMessage);
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

registerServiceWorker();
