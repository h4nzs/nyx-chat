import { create } from 'zustand';

export type PasswordSubmitResult = string | null;

export interface ModalState {
  isConfirmOpen: boolean;
  confirmTitle: string;
  confirmMessage: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: (() => void) | null;
  isChatInfoModalOpen: boolean;
  isProfileModalOpen: boolean;
  isPasswordPromptOpen: boolean;
  onPasswordSubmit: (password: PasswordSubmitResult) => void;
  profileUserId: string | null;
  showConfirm: (title: string, message: string, onConfirm: () => void, onCancel?: () => void, confirmLabel?: string, cancelLabel?: string) => void;
  hideConfirm: () => void;
  openChatInfoModal: () => void;
  closeChatInfoModal: () => void;
  openProfileModal: (userId: string) => void;
  closeProfileModal: () => void;
  showPasswordPrompt: (callback: (password: PasswordSubmitResult) => void) => void;
  hidePasswordPrompt: () => void;
}

export const useModalStore = create<ModalState>()(set => ({
  isConfirmOpen: false,
  confirmTitle: '',
  confirmMessage: '',
  confirmLabel: undefined,
  cancelLabel: undefined,
  onConfirm: () => {},
  onCancel: null,
  isChatInfoModalOpen: false,
  isProfileModalOpen: false,
  isPasswordPromptOpen: false,
  onPasswordSubmit: () => {},
  profileUserId: null,
  showConfirm: (title, message, onConfirm, onCancel, confirmLabel, cancelLabel) => set({ isConfirmOpen: true, confirmTitle: title, confirmMessage: message, onConfirm, onCancel: onCancel ?? null, confirmLabel, cancelLabel }),
  hideConfirm: () => set({ isConfirmOpen: false, confirmLabel: undefined, cancelLabel: undefined }),
  openChatInfoModal: () => set({ isChatInfoModalOpen: true }),
  closeChatInfoModal: () => set({ isChatInfoModalOpen: false }),
  openProfileModal: (userId) => set({ isProfileModalOpen: true, profileUserId: userId }),
  closeProfileModal: () => set({ isProfileModalOpen: false, profileUserId: null }),
  showPasswordPrompt: (callback) => set({ isPasswordPromptOpen: true, onPasswordSubmit: callback }),
  hidePasswordPrompt: () => set({ isPasswordPromptOpen: false }),
}));

