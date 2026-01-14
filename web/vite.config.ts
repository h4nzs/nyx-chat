import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // We will handle registration manually
      strategies: 'injectManifest',
      srcDir: '.', // sw.js is in the root of the web directory
      filename: 'sw.js',
      injectManifest: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        enabled: true
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
  define: {
    'global.Buffer': ['buffer', 'Buffer'],
  },
  server: {
    // Whitelist specific hosts to prevent DNS rebinding attacks.
    // '.ngrok.io' is for ngrok tunneling, 'localhost' for local development.
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
  preview: {
    allowedHosts: true, // Mengizinkan akses dari ngrok-free.app dll
    port: 4173,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/SetupTests.ts',
  }
});