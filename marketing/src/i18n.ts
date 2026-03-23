import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Keajaiban Vite: Ambil SEMUA file JSON di folder locales secara otomatis
const localeFiles = import.meta.glob('./locales/**/*.json', { eager: true });
// ts-ignore - Vite's glob import doesn't have perfect typings, jadi kita abaikan error ini. Kita tahu pasti bentuknya seperti ini.
const resources: Record<string, any> = {};

// Proses file-file tersebut menjadi format yang dimengerti i18next
for (const path in localeFiles) {
  // path contoh: './locales/es/landing.json'
  const match = path.match(/\.\/locales\/(.*)\/(.*)\.json/);
  if (match) {
    const lng = match[1]; // contoh: 'es'
    const ns = match[2];  // contoh: 'landing'
    
    if (!resources[lng]) resources[lng] = {};
    
    // @ts-expect-error - Vite membungkus JSON dalam .default
    resources[lng][ns] = localeFiles[path].default || localeFiles[path];
  }
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources, // Masukkan semua bahasa yang berhasil disapu
    fallbackLng: 'en',
    debug: false,
    interpolation: {
      escapeValue: false,
    },
    // Pastikan namespace ini sesuai dengan nama file JSON Anda
    ns: ['common', 'landing', 'privacy', 'help', 'auth', 'errors', 'chat', 'settings', 'modals'],
    defaultNS: 'landing',
  });

export default i18n;