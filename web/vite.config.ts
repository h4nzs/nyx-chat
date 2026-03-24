import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { createRequire } from 'module';
import packageJson from './package.json';

// Bikin fungsi 'require' palsu karena kita di environment Module (ESM)
const require = createRequire(import.meta.url);

export default defineConfig(({ mode }) => {
  const isTest = mode === 'test';

  return {
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      strategies: 'injectManifest', // Kita pakai custom SW
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        devOptions: {
          enabled: true, // Aktifkan PWA di mode dev juga
          type: 'module',
        },
        injectManifest: {
          // Naikkan limit ke 5 MB (5 * 1024 * 1024)
          // Defaultnya cuma 2 MB, sedangkan libsodium bikin bundle jadi besar
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, 
          globPatterns: ['**/*.{js,css,html,ico,png,svg,mjs,woff,woff2,ttf}'],
        },
        manifest: {
          name: 'Nyx Chat',
          short_name: 'Nyx',
          description: 'Secure, lightweight messaging app.',
          theme_color: '#1a1a1a', // Sesuaikan tema terang/gelap
          background_color: '#050505',
          display: 'standalone', // Hapus browser UI (Address bar)
          orientation: 'portrait',
          start_url: '/',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable' // Icon bulat/kotak adaptif (Android 12+)
            }
          ]
        }
      })
    ],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, "src"),
      '@components': path.resolve(__dirname, './src/components'),
      '@store': path.resolve(__dirname, './src/store'),
      '@utils': path.resolve(__dirname, './src/utils'),
      '@lib': path.resolve(__dirname, './src/lib'),
      '@pages': path.resolve(__dirname, './src/pages'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@services': path.resolve(__dirname, './src/services'),
      '@tests': path.resolve(__dirname, './src/tests'),
      'libsodium-wrappers': require.resolve('libsodium-wrappers'),
    },
  },

  optimizeDeps: {
    // Paksa Vite untuk tidak meng-optimasi libsodium-wrappers
    // Ini memperbaiki error "Could not resolve ./libsodium.mjs"
    exclude: ['libsodium-wrappers']
  },
  define: {
    // Only inject Buffer polyfill if NOT in test mode to avoid Vitest serialization crash
    ...(isTest ? {} : { 'global.Buffer': ['buffer', 'Buffer'] }),
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  server: {
    allowedHosts: true,
    fs: {
      allow: ['..']
    },
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
      '/uploads': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
        secure: false,
      }
    }
  },
  // FIX: Konfigurasi untuk npm run build && npm run preview (Port 4173)
  preview: {
    allowedHosts: true, 
    port: 4173,
    // Tambahkan Proxy di sini agar preview bisa bicara ke backend lokal
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
      '/uploads': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
        secure: false,
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
              return 'react-vendor';
            }
            if (id.includes('framer-motion') || id.includes('react-icons') || id.includes('clsx')) {
              return 'ui-vendor';
            }
            if (id.includes('libsodium-wrappers') || id.includes('bip39') || id.includes('@simplewebauthn/browser')) {
              return 'crypto-vendor';
            }
            if (id.includes('lodash') || id.includes('uuid') || id.includes('axios') || id.includes('zustand')) {
              return 'utils-vendor';
            }
          }
        }
      }
    },
    chunkSizeWarningLimit: 1000,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/SetupTests.ts',
  }
};
});
