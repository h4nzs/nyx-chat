import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  plugins: [
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
        },
        manifest: {
          name: 'Nyx Chat',
          short_name: 'Nyx',
          description: 'Secure, lightweight messaging app.',
          theme_color: '#ffffff', // Sesuaikan tema terang/gelap
          background_color: '#ffffff',
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
    },
  },

  optimizeDeps: {
    // Paksa Vite untuk tidak meng-optimasi libsodium-wrappers
    // Ini memperbaiki error "Could not resolve ./libsodium.mjs"
    exclude: ['libsodium-wrappers']
  },
  define: {
    'global.Buffer': ['buffer', 'Buffer'],
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
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'ui-vendor': ['framer-motion', 'react-icons', 'clsx', 'classnames'],
          'crypto-vendor': ['libsodium-wrappers', 'crypto-js', 'bip39', '@simplewebauthn/browser'],
          'utils-vendor': ['lodash', 'uuid', 'axios', 'zustand'],
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
});
