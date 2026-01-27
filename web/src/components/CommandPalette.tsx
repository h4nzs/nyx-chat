import { useState, useEffect, useMemo, useRef } from 'react';
import { useCommandPaletteStore, Command } from '@store/commandPalette';
import { FiSearch, FiTerminal, FiChevronRight } from 'react-icons/fi';
import { AnimatePresence, motion } from 'framer-motion';
import { useGlobalEscape } from '../hooks/useGlobalEscape';

export default function CommandPalette() {
  const { isOpen, close, commands } = useCommandPaletteStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  const filteredCommands = useMemo(() => {
    if (!searchQuery) return commands;
    const lowerCaseQuery = searchQuery.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(lowerCaseQuery) ||
        cmd.keywords?.toLowerCase().includes(lowerCaseQuery)
    );
  }, [searchQuery, commands]);

  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useGlobalEscape(() => { if (isOpen) close(); });

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
        if (command) executeCommand(command);
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
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
            className="fixed top-[15vh] left-1/2 -translate-x-1/2 z-50 w-full max-w-xl px-4"
          >
            <div className="
              relative overflow-hidden rounded-lg
              bg-black border border-accent/50
              shadow-[0_0_30px_rgba(var(--accent),0.2)]
            ">
              {/* Terminal Header */}
              <div className="flex items-center justify-between px-4 py-2 bg-accent/10 border-b border-accent/20">
                <div className="flex items-center gap-2 text-accent">
                  <FiTerminal size={14} />
                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider">System Command Line</span>
                </div>
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/50"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500/50"></div>
                </div>
              </div>

              {/* Input Area */}
              <div className="p-4 flex items-center gap-3">
                <FiChevronRight className="text-accent animate-pulse" />
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="EXECUTE_COMMAND..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="
                    w-full bg-transparent 
                    text-lg font-mono text-white 
                    placeholder-white/20 
                    focus:outline-none caret-accent
                  "
                />
              </div>

              {/* Command List */}
              <div className="max-h-[50vh] overflow-y-auto px-2 pb-2">
                {filteredCommands.length > 0 ? (
                  filteredCommands.map((cmd, index) => (
                    <button
                      ref={index === selectedIndex ? activeItemRef : null}
                      key={cmd.id}
                      onClick={() => executeCommand(cmd)}
                      onMouseMove={() => setSelectedIndex(index)}
                      className={`
                        w-full text-left p-3 flex items-center gap-4 rounded-md transition-all font-mono text-sm
                        ${index === selectedIndex 
                          ? 'bg-accent/20 text-accent border border-accent/30 shadow-[inset_0_0_10px_rgba(var(--accent),0.1)]' 
                          : 'text-white/60 hover:text-white hover:bg-white/5'}
                      `}
                    >
                      <span className="opacity-50">{cmd.icon || <FiTerminal />}</span>
                      <span className="flex-1 uppercase tracking-tight">{cmd.name}</span>
                      {index === selectedIndex && <span className="text-[10px] animate-pulse">Running...</span>}
                    </button>
                  ))
                ) : (
                  <p className="text-center text-red-500 font-mono text-sm p-4 border-t border-dashed border-red-500/30">
                    ERROR: UNKNOWN_COMMAND
                  </p>
                )}
              </div>
              
              {/* Footer */}
              <div className="px-4 py-1.5 bg-accent/5 border-t border-accent/10 flex justify-between text-[10px] font-mono text-accent/50 uppercase">
                 <span>v2.4.0-stable</span>
                 <span>ready</span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
