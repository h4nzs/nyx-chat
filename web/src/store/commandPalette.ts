import { create } from 'zustand';
import React from 'react';

export interface Command {
  id: string;
  name: string;
  action: () => void;
  section?: string; // e.g., 'Navigation', 'Conversation'
  icon?: React.ReactNode;
  keywords?: string; // For better search matching
}

interface CommandPaletteState {
  isOpen: boolean;
  commands: Command[];
  open: () => void;
  close: () => void;
  toggle: () => void;
  // Using a Map for efficient additions/removals and to prevent duplicates
  addCommands: (commands: Command[]) => void;
  removeCommands: (commandIds: string[]) => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set, _get) => ({
  isOpen: false,
  commands: [],
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set(state => ({ isOpen: !state.isOpen })),
  addCommands: (newCommands) => {
    set(state => {
      const commandMap = new Map(state.commands.map(c => [c.id, c]));
      newCommands.forEach(cmd => commandMap.set(cmd.id, cmd));
      return { commands: Array.from(commandMap.values()) };
    });
  },
  removeCommands: (commandIds) => {
    set(state => ({
      commands: state.commands.filter(c => !commandIds.includes(c.id)),
    }));
  },
}));
