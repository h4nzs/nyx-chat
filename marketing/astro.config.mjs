import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { fileURLToPath } from 'url';
import packageJson from './package.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://astro.build/config
export default defineConfig({
  // Aktifkan integrasi React
  integrations: [react()],
  
  // Konfigurasi Vite bawaan Astro (mirip vite.config.ts kita sebelumnya)
  vite: {
    plugins: [tailwindcss()],
    ssr: {
      // 👇 TAMBAHKAN INI: Memaksa react-icons diproses sebagai source, bukan external
      noExternal: ['react-icons', 'react-icons/**']
    },
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '../web/src'),
        '@lib': path.resolve(__dirname, '../web/src/lib'),
        '@utils': path.resolve(__dirname, '../web/src/utils'),
        '@hooks': path.resolve(__dirname, '../web/src/hooks'),
        '@store': path.resolve(__dirname, '../web/src/store'),
        '@components': path.resolve(__dirname, '../web/src/components'),
      }
    }
  }
});
