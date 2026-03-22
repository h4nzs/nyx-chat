import { useEffect, useRef, useState, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useContextMenuStore } from '../store/contextMenu';
import { useShallow } from 'zustand/react/shallow';
import clsx from 'clsx';
import { FiPlus, FiChevronLeft } from 'react-icons/fi';
import EmojiPicker, { EmojiClickData, Theme } from 'emoji-picker-react';
import { useThemeStore } from '@store/theme';
import { useTranslation } from 'react-i18next';

export default function ContextMenu() {
  const { t } = useTranslation(['common']);
  const { isOpen, x, y, options, reactions, closeMenu } = useContextMenuStore(useShallow(s => ({
    isOpen: s.isOpen, x: s.x, y: s.y, options: s.options, reactions: s.reactions, closeMenu: s.closeMenu
  })));
  const theme = useThemeStore(s => s.theme);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [showAllEmojis, setShowAllEmojis] = useState(false);

  useEffect(() => {
    if (isOpen && menuRef.current) {
      setShowAllEmojis(false); // Reset to quick reactions
      const menuWidth = menuRef.current.offsetWidth;
      const menuHeight = menuRef.current.offsetHeight;
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      let newLeft = x;
      let newTop = y;

      // Intelligent Edge Detection
      if (x + menuWidth > windowWidth - 16) {
        newLeft = x - menuWidth;
      }
      if (y + menuHeight > windowHeight - 16) {
        newTop = y - menuHeight;
      }

      // Ensure it doesn't go off-screen to the top/left
      newLeft = Math.max(16, newLeft);
      newTop = Math.max(16, newTop);

      setPosition({ left: newLeft, top: newTop });
    }
  }, [isOpen, x, y, options, reactions]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    
    // Slight delay to prevent immediate closure if the trigger click propagated
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
    }, 10);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isOpen, closeMenu]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.95, filter: 'blur(4px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.95, filter: 'blur(4px)' }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          style={{ top: position.top, left: position.left }}
          className="fixed z-[100] min-w-[200px] flex flex-col rounded-2xl
                     bg-bg-main/80 backdrop-blur-xl
                     border border-white/20 dark:border-white/10
                     shadow-[0_8px_32px_rgba(0,0,0,0.25)]
                     dark:shadow-[0_8px_32px_rgba(0,0,0,0.5)]
                     overflow-hidden"
        >
          {showAllEmojis ? (
            /* EXPANDED EMOJI PICKER */
            <motion.div 
               initial={{ height: 0, opacity: 0 }} 
               animate={{ height: 'auto', opacity: 1 }} 
               className="flex flex-col"
            >
               <div className="flex items-center p-2 border-b border-white/10 bg-secondary/30">
                  <button 
                     onClick={() => setShowAllEmojis(false)}
                     className="p-2 rounded-full hover:bg-white/10 text-text-secondary transition-colors"
                  >
                     <FiChevronLeft size={18} />
                  </button>
                  <span className="text-xs font-bold text-text-secondary uppercase tracking-wider ml-2">{t('context_menu.all_reactions')}</span>
               </div>
               <div className="p-1">
                 <Suspense fallback={<div className="w-[300px] h-[400px] flex items-center justify-center text-text-secondary">{t('actions.loading')}</div>}>
                   <EmojiPicker 
                      onEmojiClick={(emojiData: EmojiClickData) => {
                         if (typeof (window as unknown as { currentReactionHandler?: (emoji: string) => void }).currentReactionHandler === 'function') {
                            (window as unknown as { currentReactionHandler: (emoji: string) => void }).currentReactionHandler(emojiData.emoji);
                         }
                         closeMenu();
                      }}
                      theme={theme === 'dark' ? Theme.DARK : Theme.LIGHT}
                      lazyLoadEmojis={true}
                      searchDisabled={false}
                      skinTonesDisabled={true}
                      width={300}
                      height={400}
                   />
                 </Suspense>
               </div>
            </motion.div>
          ) : (
            /* DEFAULT QUICK REACTIONS & OPTIONS */
            <>
              {/* Reactions Row */}
              {reactions && reactions.length > 0 && (
                <div className="flex items-center justify-between p-2 border-b border-black/5 dark:border-white/5 bg-secondary/30">
                  {reactions.map((reaction) => (
                    <button
                      key={reaction.emoji}
                      onClick={() => {
                        reaction.onClick();
                        closeMenu();
                      }}
                      className="p-2 rounded-full hover:bg-accent/20 hover:scale-110 active:scale-95 transition-all text-xl"
                    >
                      {reaction.emoji}
                    </button>
                  ))}
                  
                  {/* EXPAND BUTTON */}
                  <button
                    onClick={() => setShowAllEmojis(true)}
                    className="p-2.5 rounded-full hover:bg-white/10 hover:scale-110 active:scale-95 transition-all text-text-secondary shadow-neumorphic-convex-sm flex items-center justify-center ml-1 bg-white/5"
                    title="More Reactions"
                  >
                    <FiPlus size={16} />
                  </button>
                </div>
              )}

              {/* Options */}
              <div className="flex flex-col py-1">
                {options.map((option) => (
                  <button
                    key={option.label}
                    onClick={() => {
                      option.onClick();
                      closeMenu();
                    }}
                    className={clsx(
                      "flex items-center gap-3 px-4 py-2.5 text-sm font-semibold transition-colors",
                      option.destructive
                        ? "text-red-500 hover:bg-red-500/10"
                        : "text-text-primary hover:bg-white/10 dark:hover:bg-white/5"
                    )}
                  >
                    {option.icon && <span className="opacity-80">{option.icon}</span>}
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
