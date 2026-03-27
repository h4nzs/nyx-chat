import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';

i18n
  // Pake backend buat narik file JSON terjemahan dari public folder
  .use(HttpBackend)
  // Otomatis deteksi bahasa browser (Indonesia, Inggris, dll)
  .use(LanguageDetector)
  // Oper instance i18n ke react-i18next
  .use(initReactI18next)
  .init({
    fallbackLng: 'en', // Kalau bahasa user ga didukung, balik ke Inggris
    debug: process.env.NODE_ENV === 'development',
    
    interpolation: {
      escapeValue: false, // React udah aman dari XSS
    },
    backend: {
      // Path tempat kita nyimpen file terjemahan nanti
      loadPath: '/locales/{{lng}}/{{ns}}.json',
    },
    // Pisahin file berdasarkan konteks biar enteng
    ns: ['common', 'auth', 'errors', 'chat', 'settings', 'modals'],
    defaultNS: 'common',
    partialBundledLanguages: true,
  });

export default i18n;
