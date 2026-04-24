// marketing/src/utils/i18n.ts
export const LANGUAGES = [
  { code: 'en', short: 'EN', label: '🇺🇸 English' },
  { code: 'id', short: 'ID', label: '🇮🇩 Indonesia' },
  { code: 'es', short: 'ES', label: '🇪🇸 Español' },
  { code: 'pt-BR', short: 'PT', label: '🇧🇷 Português' },
];

interface ViteLocaleModule {
  default?: Record<string, unknown>;
  [key: string]: unknown;
}

const localeFiles = import.meta.glob('../locales/**/*.json', { eager: true });
const translations: Record<string, Record<string, unknown>> = {};

for (const path in localeFiles) {
  // Memecah path (contoh: '../locales/id/landing.json' menjadi array)
  const parts = path.split('/');
  
  // Ambil nama folder bahasa dan nama file JSON-nya dengan aman
  const lng = parts[parts.length - 2];
  const ns = parts[parts.length - 1].replace('.json', '');
  
  if (!translations[lng]) translations[lng] = {};
  
  const moduleData = localeFiles[path] as ViteLocaleModule;
  translations[lng][ns] = moduleData.default || moduleData;
}
export function getLangFromUrl(url: URL) {
  // Pecah URL (contoh: '/id/privacy' menjadi ['id', 'privacy'])
  const parts = url.pathname.split('/').filter(Boolean);
  
  // Pindai seluruh bagian URL. Jika ada 'id', 'es', atau 'pt-BR', langsung gunakan!
  for (const part of parts) {
    if (translations[part]) {
      return part;
    }
  }
  
  return 'en'; // Fallback aman
}

export function useTranslations(lang: string) {
  return function t(key: string, options?: Record<string, string>) {
    const [ns, path] = key.includes(':') ? key.split(':') : ['landing', key];
    const keys = path.split('.');
    
    let value = translations[lang]?.[ns];
    
    for (const k of keys) {
      if (value !== undefined && typeof value === 'object' && value !== null) {
        value = (value as Record<string, unknown>)[k];
      } else {
        value = undefined;
        break;
      }
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