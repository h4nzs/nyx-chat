import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import packageJson from './package.json';


export default defineConfig({
  plugins: [react()],
  define: {
    // Mendefinisikan variabel global agar dikenali oleh aplikasi
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      // Memberitahu vite bahwa '@store' mengarah ke folder src/store
      '@store': path.resolve(__dirname, './src/store'),
    },
  },
})