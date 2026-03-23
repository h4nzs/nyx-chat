import ModalBase from './ui/ModalBase';
import { useModalStore } from '@store/modal';
import { useShallow } from 'zustand/react/shallow';
import { FiKey, FiAlertTriangle, FiZap, FiLock, FiHelpCircle } from 'react-icons/fi';
import { useTranslation, Trans } from 'react-i18next';

const InfoSection = ({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) => (
  <div className="flex items-start gap-4">
    <div className="flex-shrink-0 text-[hsl(var(--grad-start))] mt-1">{icon}</div>
    <div>
      <h3 className="font-semibold text-text-primary">{title}</h3>
      <div className="text-sm text-text-secondary space-y-2">{children}</div>
    </div>
  </div>
);

export default function ChatInfoModal() {
  const { t } = useTranslation(['modals']);
  const { isChatInfoModalOpen, closeChatInfoModal } = useModalStore(useShallow(s => ({
    isChatInfoModalOpen: s.isChatInfoModalOpen, closeChatInfoModal: s.closeChatInfoModal
  })));

  return (
    <ModalBase
      isOpen={isChatInfoModalOpen}
      onClose={closeChatInfoModal}
      title={t('modals:chat_info.title')}
    >
      <div className="space-y-6">

        <InfoSection icon={<FiLock size={20} />} title={t('modals:chat_info.e2ee.title')}>
          <p>
            <Trans i18nKey="modals:chat_info.e2ee.content_1">
              All your conversations are protected by strong <span className="font-semibold text-text-primary">End-to-End Encryption</span>, inspired by the Signal Protocol. Think of it as a private digital vault.
            </Trans>
          </p>
          <p>
            {t('modals:chat_info.e2ee.content_2')}
          </p>
        </InfoSection>

        <InfoSection icon={<FiKey size={20} />} title={t('modals:chat_info.keys.title')}>
          <p>
            <Trans i18nKey="modals:chat_info.keys.content_1">
              Your entire account is secured by a single <span className="font-semibold text-text-primary">&quot;Master Key&quot;</span>. This key is generated from your unique 24-word <span className="font-semibold text-text-primary">Recovery Phrase</span> that you received during registration.
            </Trans>
          </p>
          <p className="p-3 bg-accent/10 text-accent rounded-lg">
            <Trans i18nKey="modals:chat_info.keys.important">
              <span className="font-bold">The most important concept:</span> Your Recovery Phrase is the only way to access your account if you forget your password or switch devices without access to an old one. We do not store it and cannot recover it for you.
            </Trans>
          </p>
        </InfoSection>

        <InfoSection icon={<FiZap size={20} />} title={t('modals:chat_info.storage.title')}>
          <p>
            <Trans i18nKey="modals:chat_info.storage.content_1">
              For your convenience, your Master Key is stored on this device in a highly secure, encrypted bundle. This bundle is &quot;locked&quot; using your <span className="font-semibold text-text-primary">password</span>.
            </Trans>
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li>{t('modals:chat_info.storage.list_1')}</li>
            <li>{t('modals:chat_info.storage.list_2')}</li>
          </ul>
        </InfoSection>

        <InfoSection icon={<FiAlertTriangle size={20} />} title={t('modals:chat_info.access.title')}>
          <p>
            {t('modals:chat_info.access.content_1')}
          </p>
          <ul className="list-disc list-inside space-y-2 mt-2">
            <li>
              <span className="font-semibold text-text-primary">{t('modals:chat_info.access.list_1_label')}</span> {t('modals:chat_info.access.list_1_text')}
            </li>
            <li>
              <span className="font-semibold text-text-primary">{t('modals:chat_info.access.list_2_label')}</span> {t('modals:chat_info.access.list_2_text')}
            </li>
            <li>
              <span className="font-semibold text-text-primary">{t('modals:chat_info.access.list_3_label')}</span> <Trans i18nKey="modals:chat_info.access.list_3_text">If you lost your device and backups, use the &quot;Restore&quot; feature with your 24-word Recovery Phrase. This will reset your password and restore your Identity Keys, but <strong className="text-destructive">chat history will be lost</strong> without a Vault backup.</Trans>
            </li>
          </ul>
        </InfoSection>

        <InfoSection icon={<FiHelpCircle size={20} />} title={t('modals:chat_info.best_practices.title')}>
           <ul className="list-disc list-inside space-y-2">
            <li><Trans i18nKey="modals:chat_info.best_practices.do_store"><span className="font-semibold text-text-primary">DO</span> store your Recovery Phrase in a very safe, offline location (e.g., a safe, physical note, or an encrypted password manager).</Trans></li>
            <li><Trans i18nKey="modals:chat_info.best_practices.do_verify"><span className="font-semibold text-text-primary">DO</span> verify your contacts&apos; identities using the available security features before sharing sensitive information.</Trans></li>
            <li><Trans i18nKey="modals:chat_info.best_practices.dont_share"><span className="font-semibold text-destructive">DO NOT</span> share your password or Recovery Phrase with anyone. Ever.</Trans></li>
            <li><Trans i18nKey="modals:chat_info.best_practices.dont_public"><span className="font-semibold text-destructive">DO NOT</span> stay logged in on public or shared computers. Use the &quot;Active Sessions&quot; feature in Settings to log out remotely if needed.</Trans></li>
          </ul>
        </InfoSection>

      </div>
    </ModalBase>
  );
}
