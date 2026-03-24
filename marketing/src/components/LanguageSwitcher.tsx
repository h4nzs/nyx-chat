// marketing/src/components/LanguageSwitcher.tsx
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { FiGlobe, FiCheck } from 'react-icons/fi';

interface LanguageSwitcherProps {
  isAbsolute?: boolean;
  currentLangCode?: string; // 👈 Astro akan mengirim data ini!
}

const LANGUAGES = [
  { code: 'en', short: 'EN', label: '🇺🇸 English' },
  { code: 'id', short: 'ID', label: '🇮🇩 Indonesia' },
  { code: 'es', short: 'ES', label: '🇪🇸 Español' },
  { code: 'pt-BR', short: 'PT', label: '🇧🇷 Português' },
];

export default function LanguageSwitcher({ isAbsolute = true, currentLangCode = 'en' }: LanguageSwitcherProps) {

  const changeLanguage = (lng: string) => {
    const currentPath = window.location.pathname;
    
    // Hapus kode bahasa lama dari URL jika ada
    let newPath = currentPath.replace(/^\/(id|es|pt-BR)(\/|$)/, '/');
    
    // Pasang kode bahasa baru
    if (lng !== 'en') {
      newPath = `/${lng}${newPath === '/' ? '' : newPath}`;
    }
    
    window.location.assign(newPath || '/');
  };

  // Cari bahasa berdasarkan properti dari Astro
  const currentLang = LANGUAGES.find(l => l.code === currentLangCode) || LANGUAGES[0];
  
  const containerClass = isAbsolute ? "absolute top-4 right-4 z-50" : "relative z-50";

  return (
    <div className={containerClass}>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-surface text-text-primary shadow-[3px_3px_6px_rgba(0,0,0,0.2),-3px_-3px_6px_rgba(255,255,255,0.1)] hover:shadow-[inset_1px_1px_3px_rgba(0,0,0,0.2)] transition-all font-bold text-sm focus:outline-none">
            <FiGlobe className="text-accent" />
            <span>{currentLang.short}</span>
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content 
            className="z-[100] min-w-[150px] bg-bg-surface rounded-xl p-2 shadow-[8px_8px_16px_rgba(0,0,0,0.4),-8px_-8px_16px_rgba(255,255,255,0.05)] border border-white/5 animate-in fade-in zoom-in-95 duration-200 mt-2"
            align="end"
          >
            {LANGUAGES.map((l) => (
              <DropdownMenu.Item 
                key={l.code}
                onClick={() => changeLanguage(l.code)}
                className="flex items-center justify-between px-3 py-2 rounded-lg text-sm cursor-pointer outline-none hover:bg-white/5 focus:bg-white/5 transition-colors group"
              >
                <span className={`font-medium ${currentLang.code === l.code ? 'text-accent' : 'text-text-primary group-hover:text-accent'}`}>
                  {l.label}
                </span>
                {currentLang.code === l.code && <FiCheck className="text-accent" />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}