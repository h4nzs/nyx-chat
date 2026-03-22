import { useTranslation } from 'react-i18next';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { FiGlobe, FiCheck } from 'react-icons/fi';

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
  };

  return (
    <div className="absolute top-4 right-4 z-50">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="inline-flex items-center justify-center rounded-md bg-black/30 backdrop-blur-md px-3 py-2 text-sm font-medium text-gray-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/75 transition-all shadow-lg border border-white/5">
            <FiGlobe className="w-4 h-4 mr-2" />
            {i18n.language === 'id' ? 'ID' : 'EN'}
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content 
            className="min-w-[140px] bg-[#1a1a1a] rounded-md p-1 shadow-xl ring-1 ring-white/10 z-[100] animate-in fade-in zoom-in-95 duration-200"
            sideOffset={5}
            align="end"
          >
            <DropdownMenu.Item 
              className={`group flex items-center px-2 py-2 text-sm rounded-md outline-none cursor-pointer transition-colors ${i18n.language === 'en' ? 'bg-orange-500/20 text-orange-400' : 'text-gray-300 hover:bg-white/10'}`}
              onClick={() => changeLanguage('en')}
            >
              <span className="flex-1">🇺🇸 English</span>
              {i18n.language === 'en' && <FiCheck className="ml-2 w-4 h-4" />}
            </DropdownMenu.Item>

            <DropdownMenu.Item 
              className={`group flex items-center px-2 py-2 text-sm rounded-md outline-none cursor-pointer transition-colors ${i18n.language === 'id' ? 'bg-orange-500/20 text-orange-400' : 'text-gray-300 hover:bg-white/10'}`}
              onClick={() => changeLanguage('id')}
            >
              <span className="flex-1">🇮🇩 Indonesia</span>
              {i18n.language === 'id' && <FiCheck className="ml-2 w-4 h-4" />}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}