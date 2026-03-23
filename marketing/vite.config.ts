import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import packageJson from './package.json';


export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  define: {
    // Mendefinisikan variabel global agar dikenali oleh aplikasi
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      '@store': path.resolve(__dirname, '../web/src/store'), // 👈 Arahkan ke store utama
      // Jika Anda mengimport komponen dengan '../components', tangkap aliasnya:
      '@components': path.resolve(__dirname, '../web/src/components'),
      // Atau arahkan semua import yang spesifik
    },
  },
})