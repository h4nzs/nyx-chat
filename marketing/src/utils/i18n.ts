// marketing/src/utils/i18n.ts
export const LANGUAGES = [
  { code: 'en', short: 'EN', label: '🇺🇸 English' },
  { code: 'id', short: 'ID', label: '🇮🇩 Indonesia' },
  { code: 'es', short: 'ES', label: '🇪🇸 Español' },
  { code: 'pt-BR', short: 'PT', label: '🇧🇷 Português' },
];

// Ambil SEMUA file JSON di folder locales secara otomatis saat build
const localeFiles = import.meta.glob('../locales/**/*.json', { eager: true });
const translations: Record<string, any> = {};

for (const path in localeFiles) {
  const match = path.match(/\.\.\/locales\/(.*)\/(.*)\.json/);
  if (match) {
    const [, lng, ns] = match;
    if (!translations[lng]) translations[lng] = {};
    // @ts-expect-error - TypeScript tidak tahu struktur hasil import, jadi kita paksa saja
    translations[lng][ns] = localeFiles[path].default || localeFiles[path];
  }
}

export function getLangFromUrl(url: URL) {
  const [, lang] = url.pathname.split('/');
  return translations[lang] ? lang : 'en';
}

export function useTranslations(lang: string) {
  return function t(key: string, options?: Record<string, string>) {
    // Pisahkan namespace (misal: "privacy:seo.title" -> ns="privacy", path="seo.title")
    const [ns, path] = key.includes(':') ? key.split(':') : ['landing', key];
    const keys = path.split('.');
    
    let value = translations[lang]?.[ns];
    
    for (const k of keys) {
      if (value === undefined) break;
      value = value[k];
    }
    
    let text = typeof value === 'string' ? value : key;
    
    // Replace variabel seperti {{year}}
    if (options && typeof text === 'string') {
        Object.keys(options).forEach(optKey => {
            text = text.replace(`{{${optKey}}}`, options[optKey]);
        });
    }
    
    return text;
  }
}