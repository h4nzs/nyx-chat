import { useState, useEffect, useMemo, useRef } from 'react';
import { useCommandPaletteStore, Command } from '@store/commandPalette';
import { FiSearch } from 'react-icons/fi';
import { AnimatePresence, motion } from 'framer-motion';
import { useGlobalEscape } from '../hooks/useGlobalEscape';

export default function CommandPalette() {
  const { isOpen, close, commands } = useCommandPaletteStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  // Filter commands based on search query
  const filteredCommands = useMemo(() => {
    if (!searchQuery) return commands;
    const lowerCaseQuery = searchQuery.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(lowerCaseQuery) ||
        cmd.keywords?.toLowerCase().includes(lowerCaseQuery)
    );
  }, [searchQuery, commands]);

  // Reset search and selection when opening
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 100); // Delay focus slightly
    }
  }, [isOpen]);

  // Scroll active item into view
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({
      block: 'nearest',
    });
  }, [selectedIndex]);

  // Handle closing with Escape key
  useGlobalEscape(() => {
    if (isOpen) close();
  });

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen || filteredCommands.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const command = filteredCommands[selectedIndex];
        if (command) {
          executeCommand(command);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filteredCommands, selectedIndex, close]);

  const executeCommand = (command: Command) => {
    command.action();
    close();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
          />
          {/* Palette */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            transition={{ duration: 0.2 }}
            className="fixed top-[10vh] left-1/2 -translate-x-1/2 z-50 w-full max-w-md sm:max-w-lg md:max-w-xl"
          >
            <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex flex flex-col">
              <div className="p-3 flex items-center gap-3 border-b border-border">
                <FiSearch className="text-text-secondary" />
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Type a command or search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-transparent text-text-primary placeholder-text-secondary focus:outline-none"
                />
              </div>
              <div className="max-h-[60vh] sm:max-h-[50vh] overflow-y-auto p-2">
                {filteredCommands.length > 0 ? (
                  filteredCommands.map((cmd, index) => (
                    <button
                      ref={index === selectedIndex ? activeItemRef : null}
                      key={cmd.id}
                      onClick={() => executeCommand(cmd)}
                      onMouseMove={() => setSelectedIndex(index)}
                      className={`w-full text-left p-3 flex items-center gap-4 rounded-lg transition-colors ${
                        index === selectedIndex ? 'bg-accent text-white' : 'hover:bg-secondary'
                      }`}
                    >
                      {cmd.icon && <span className="flex-shrink-0 w-5 text-text-secondary">{cmd.icon}</span>}
                      <span className="flex-1">{cmd.name}</span>
                    </button>
                  ))
                ) : (
                  <p className="text-center text-text-secondary p-4">No results found.</p>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
