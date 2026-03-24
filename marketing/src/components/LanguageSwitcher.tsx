import { useTranslation } from 'react-i18next';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { FiGlobe, FiCheck } from 'react-icons/fi';

// Tambahkan props agar komponen ini fleksibel
interface LanguageSwitcherProps {
  isAbsolute?: boolean;
}

// Daftar bahasa ditaruh di array agar gampang ditambah/dikurangi nantinya
const LANGUAGES = [
  { code: 'en', short: 'EN', label: '🇺🇸 English' },
  { code: 'id', short: 'ID', label: '🇮🇩 Indonesia' },
  { code: 'es', short: 'ES', label: '🇪🇸 Español' },
  { code: 'pt-BR', short: 'PT', label: '🇧🇷 Português Brazil' },
];

export default function LanguageSwitcher({ isAbsolute = true }: LanguageSwitcherProps) {
  const { i18n } = useTranslation();

  const changeLanguage = (lng: string) => {
    // 👇 UBAH LOGIKA DI SINI: Navigasi URL alih-alih ganti state
    const currentPath = window.location.pathname;
    
    // Hapus prefix bahasa saat ini (jika ada)
    let newPath = currentPath.replace(/^\/(id|es|pt-BR)(\/|$)/, '/');
    
    // Tambahkan prefix bahasa baru (kecuali untuk English / default)
    if (lng !== 'en') {
      newPath = `/${lng}${newPath === '/' ? '' : newPath}`;
    }
    
    // Pindah halaman
    window.location.assign(newPath || '/');
  };

  const currentLang = LANGUAGES.find(l => l.code === i18n.language) || LANGUAGES[0];
  const containerClass = isAbsolute ? "absolute top-4 right-4 z-50" : "relative z-50";

  return (
    <div className={containerClass}>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="inline-flex items-center justify-center rounded-md bg-black/30 backdrop-blur-md px-3 py-2 text-sm font-medium text-gray-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/75 transition-all shadow-lg border border-white/5">
            <FiGlobe className="w-4 h-4 mr-2" />
            {currentLang.short}
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content 
            className="min-w-[140px] bg-[#1a1a1a] rounded-md p-1 shadow-xl ring-1 ring-white/10 z-[100] animate-in fade-in zoom-in-95 duration-200"
            sideOffset={5}
            align="end"
          >
            {LANGUAGES.map((lang) => {
              const isActive = i18n.language === lang.code;
              return (
                <DropdownMenu.Item 
                  key={lang.code}
                  className={`group flex items-center px-2 py-2 text-sm rounded-md outline-none cursor-pointer transition-colors ${
                    isActive ? 'bg-orange-500/20 text-orange-400' : 'text-gray-300 hover:bg-white/10'
                  }`}
                  onClick={() => changeLanguage(lang.code)}
                >
                  <span className="flex-1">{lang.label}</span>
                  {isActive && <FiCheck className="ml-2 w-4 h-4" />}
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}