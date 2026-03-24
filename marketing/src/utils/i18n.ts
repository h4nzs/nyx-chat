// marketing/src/utils/i18n.ts
export const LANGUAGES = [
  { code: 'en', short: 'EN', label: '🇺🇸 English' },
  { code: 'id', short: 'ID', label: '🇮🇩 Indonesia' },
  { code: 'es', short: 'ES', label: '🇪🇸 Español' },
  { code: 'pt-BR', short: 'PT', label: '🇧🇷 Português' },
];

const localeFiles = import.meta.glob('../locales/**/*.json', { eager: true });
const translations: Record<string, any> = {};

for (const path in localeFiles) {
  // Memecah path (contoh: '../locales/id/landing.json' menjadi array)
  const parts = path.split('/');
  
  // Ambil nama folder bahasa dan nama file JSON-nya dengan aman
  const lng = parts[parts.length - 2];
  const ns = parts[parts.length - 1].replace('.json', '');
  
  if (!translations[lng]) translations[lng] = {};
  // @ts-expect-error - Kita tahu struktur ini benar karena kontrol kita atas file JSON
  translations[lng][ns] = localeFiles[path].default || localeFiles[path];
}

export function getLangFromUrl(url: URL) {
  // Pecah URL (contoh: '/id/privacy' menjadi ['id', 'privacy'])
  const parts = url.pathname.split('/').filter(Boolean);
  const lang = parts[0];
  
  if (lang && translations[lang]) {
    return lang;
  }
  return 'en'; // Fallback aman
}

export function useTranslations(lang: string) {
  return function t(key: string, options?: Record<string, string>) {
    const [ns, path] = key.includes(':') ? key.split(':') : ['landing', key];
    const keys = path.split('.');
    
    let value = translations[lang]?.[ns];
    
    for (const k of keys) {
      if (value === undefined) break;
      value = value[k];
    }
    
    let text = typeof value === 'string' ? value : key;
    
    if (options && typeof text === 'string') {
        Object.keys(options).forEach(optKey => {
            text = text.replace(`{{${optKey}}}`, options[optKey]);
        });
    }
    
    return text;
  }
}