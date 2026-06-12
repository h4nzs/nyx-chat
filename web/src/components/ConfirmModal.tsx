import { useModalStore } from '@store/modal';
import { useShallow } from 'zustand/react/shallow';
import ModalBase from './ui/ModalBase';
import { useTranslation } from 'react-i18next';

const ConfirmModal = () => {
  const { t } = useTranslation(['common']);
  const { isConfirmOpen, confirmTitle, confirmMessage, confirmLabel, cancelLabel, onConfirm, onCancel, hideConfirm } = useModalStore(useShallow(state => ({
    isConfirmOpen: state.isConfirmOpen,
    confirmTitle: state.confirmTitle,
    confirmMessage: state.confirmMessage,
    confirmLabel: state.confirmLabel,
    cancelLabel: state.cancelLabel,
    onConfirm: state.onConfirm,
    onCancel: state.onCancel,
    hideConfirm: state.hideConfirm,
  })));

  return (
    <ModalBase
      isOpen={isConfirmOpen}
      onClose={hideConfirm}
      title={confirmTitle}
      footer={(
        <>
          <button
            onClick={() => {
              onCancel?.();
              hideConfirm();
            }}
            className="px-4 py-2 rounded-lg bg-bg-surface text-text-primary shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
          >
            {cancelLabel || t('actions.cancel')}
          </button>
          <button
            onClick={() => {
              onConfirm();
              hideConfirm();
            }}
            className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
          >
            {confirmLabel || t('actions.confirm')}
          </button>
        </>
      )}
    >
      <p className="text-text-secondary whitespace-pre-wrap">{confirmMessage}</p>
    </ModalBase>
  );
};

export default ConfirmModal;
