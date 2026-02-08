import { useModalStore } from '@store/modal';
import ModalBase from './ui/ModalBase';

const ConfirmModal = () => {
  const { isConfirmOpen, confirmTitle, confirmMessage, onConfirm, hideConfirm } = useModalStore(state => ({
    isConfirmOpen: state.isConfirmOpen,
    confirmTitle: state.confirmTitle,
    confirmMessage: state.confirmMessage,
    onConfirm: state.onConfirm,
    hideConfirm: state.hideConfirm,
  }));

  return (
    <ModalBase
      isOpen={isConfirmOpen}
      onClose={hideConfirm}
      title={confirmTitle}
      footer={(
        <>
          <button
            onClick={hideConfirm}
            className="px-4 py-2 rounded-lg bg-bg-surface text-text-primary shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onConfirm();
              hideConfirm();
            }}
            className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
          >
            Confirm
          </button>
        </>
      )}
    >
      <p className="text-text-secondary whitespace-pre-wrap">{confirmMessage}</p>
    </ModalBase>
  );
};

export default ConfirmModal;
