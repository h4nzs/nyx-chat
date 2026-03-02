import { create } from 'zustand';

export type PasswordSubmitResult = { mode: 'normal', password?: string } | { mode: 'decoy' } | null;

export interface ModalState {
  isConfirmOpen: boolean;
  confirmTitle: string;
  confirmMessage: string;
  onConfirm: () => void;
  isChatInfoModalOpen: boolean;
  isProfileModalOpen: boolean;
  isPasswordPromptOpen: boolean;
  onPasswordSubmit: (result: PasswordSubmitResult) => void;
  profileUserId: string | null;
  showConfirm: (title: string, message: string, onConfirm: () => void) => void;
  hideConfirm: () => void;
  openChatInfoModal: () => void;
  closeChatInfoModal: () => void;
  openProfileModal: (userId: string) => void;
  closeProfileModal: () => void;
  showPasswordPrompt: (callback: (result: PasswordSubmitResult) => void) => void;
  hidePasswordPrompt: () => void;
}

export const useModalStore = create<ModalState>()(set => ({
  isConfirmOpen: false,
  confirmTitle: '',
  confirmMessage: '',
  onConfirm: () => {},
  isChatInfoModalOpen: false,
  isProfileModalOpen: false,
  isPasswordPromptOpen: false,
  onPasswordSubmit: () => {},
  profileUserId: null,
  showConfirm: (title, message, onConfirm) => set({ isConfirmOpen: true, confirmTitle: title, confirmMessage: message, onConfirm }),
  hideConfirm: () => set({ isConfirmOpen: false }),
  openChatInfoModal: () => set({ isChatInfoModalOpen: true }),
  closeChatInfoModal: () => set({ isChatInfoModalOpen: false }),
  openProfileModal: (userId) => set({ isProfileModalOpen: true, profileUserId: userId }),
  closeProfileModal: () => set({ isProfileModalOpen: false, profileUserId: null }),
  showPasswordPrompt: (callback) => set({ isPasswordPromptOpen: true, onPasswordSubmit: callback }),
  hidePasswordPrompt: () => set({ isPasswordPromptOpen: false }),
}));

