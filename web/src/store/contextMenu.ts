import { create } from 'zustand';
import React from 'react';

export interface ContextMenuOption {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}

export interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  options: ContextMenuOption[];
  reactions?: { emoji: string; onClick: () => void }[];
  closeMenu: () => void;
  openMenu: (
    e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent,
    options: ContextMenuOption[],
    reactions?: { emoji: string; onClick: () => void }[]
  ) => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  isOpen: false,
  x: 0,
  y: 0,
  options: [],
  reactions: undefined,
  closeMenu: () => set({ isOpen: false }),
  openMenu: (e, options, reactions) => {
    e.preventDefault();
    let clientX = 0;
    let clientY = 0;

    if ('clientX' in e) {
      clientX = e.clientX;
      clientY = e.clientY;
    } else if ('touches' in e && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    }

    set({
      isOpen: true,
      x: clientX,
      y: clientY,
      options,
      reactions,
    });
  },
}));
