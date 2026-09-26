// Zod jitless — WAJIB paling awal agar tidak ada schema yang terkompilasi
// dengan eval/Function() (CSP prod tanpa 'unsafe-eval').
import './zodSetup';
import { Buffer } from 'buffer';
window.Buffer = Buffer;

import './i18n';
import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { registerServiceWorker } from '@lib/serviceWorkerRegistration';
import { setAuthFailureHandler } from '@lib/api';
import { useAuthStore } from '@store/auth';
import { installOtpkMidSessionRefill } from '@utils/crypto';

// === WebMCP: Expose site tools to AI agents via the browser ===
// See: https://webmachinelearning.github.io/webmcp/
function initWebMCP(): void {
  if (typeof navigator === 'undefined' || !('modelContext' in navigator)) return;
  
  try {
    const mc = (navigator as unknown as { modelContext: { provideContext: (ctx: unknown) => void } }).modelContext;
    
    mc.provideContext({
      tools: [
        {
          name: 'search_users',
          description: 'Search for users by username hash to start a conversation',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Username hash to search for' }
            },
            required: ['query']
          },
          execute: async (args: { query: string }) => {
            const response = await fetch('/api/users/search?q=' + encodeURIComponent(args.query), { credentials: 'include' });
            return response.json();
          }
        },
        {
          name: 'list_conversations',
          description: 'List all conversations for the authenticated user',
          inputSchema: {
            type: 'object',
            properties: {}
          },
          execute: async () => {
            const response = await fetch('/api/conversations/sync', { credentials: 'include' });
            return response.json();
          }
        },
        {
          name: 'get_messages',
          description: 'Get messages from a specific conversation',
          inputSchema: {
            type: 'object',
            properties: {
              conversationId: { type: 'string', description: 'Conversation ID to fetch messages from' },
              limit: { type: 'integer', description: 'Max messages to return', default: 50 }
            },
            required: ['conversationId']
          },
          execute: async (args: { conversationId: string; limit?: number }) => {
            const response = await fetch('/api/messages/' + encodeURIComponent(args.conversationId), { credentials: 'include' });
            return response.json();
          }
        },
        {
          name: 'get_system_status',
          description: 'Check the current system status and any active banners',
          inputSchema: {
            type: 'object',
            properties: {}
          },
          execute: async () => {
            const response = await fetch('/api/system/status', { credentials: 'include' });
            return response.json();
          }
        }
      ]
    });
    
    console.log('[WebMCP] Tools registered with navigator.modelContext');
  } catch (e) {
    // WebMCP API not available or registration failed — non-critical
    console.debug('[WebMCP] Not available:', e);
  }
}

// Initialize WebMCP after a short delay to ensure app is loaded
if (typeof window !== 'undefined') {
  setTimeout(initWebMCP, 2000);
}

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

// === GLOBAL ERROR HANDLING ===
// Client-side telemetry removed by design (zero client telemetry policy).
window.onerror = function (message, source, lineno, colno) {
  console.error('[Global] Uncaught error:', message, 'at', source, lineno + ':' + colno);
};

window.addEventListener('unhandledrejection', function (event) {
  console.error('[Global] Unhandled Promise rejection:', event.reason);
});

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
import i18n from './i18n';

// Tunggu i18n selesai memuat namespace sebelum render — mencegah "missingKey"
// transient saat komponen pertama kali render sebelum JSON lokale tiba.
async function bootstrap() {
  try {
    if (!i18n.isInitialized) {
      await new Promise<void>((resolve) => {
        i18n.on('initialized', () => resolve());
        i18n.on('failedLoading', () => resolve());
      });
    }
  } catch (_e) {
    // Jangan blokir render bila i18n gagal — fallbackLng akan menangani
  }
  // [MID-SESSION REFILL] Pemicu refill OTPK saat user kembali ke tab —
  // pengaman kedua selain refill saat login (stok < 50 → isi ulang).
  installOtpkMidSessionRefill();
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <HelmetProvider>
        <App />
      </HelmetProvider>
    </React.StrictMode>
  );
}

bootstrap();

registerServiceWorker();