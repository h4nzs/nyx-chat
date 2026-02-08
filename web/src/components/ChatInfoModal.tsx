import ModalBase from './ui/ModalBase';
import { useModalStore } from '@store/modal';
import { FiShield, FiKey, FiAlertTriangle, FiZap, FiLock, FiHelpCircle } from 'react-icons/fi';

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
  const { isChatInfoModalOpen, closeChatInfoModal } = useModalStore();

  return (
    <ModalBase
      isOpen={isChatInfoModalOpen}
      onClose={closeChatInfoModal}
      title="Understanding Your Security on Chat-Lite"
    >
      <div className="space-y-6">

        <InfoSection icon={<FiLock size={20} />} title="True End-to-End Encryption (E2EE)">
          <p>
            All your conversations are protected by strong <span className="font-semibold text-text-primary">End-to-End Encryption</span>, inspired by the Signal Protocol. Think of it as a private digital vault.
          </p>
          <p>
            Only you and the recipient have the keys to unlock messages. No one in between—not even the Chat-Lite servers—can ever read their content. This protection is automatic and always on.
          </p>
        </InfoSection>

        <InfoSection icon={<FiKey size={20} />} title="Your Master Key & Recovery Phrase">
          <p>
            Your entire account is secured by a single <span className="font-semibold text-text-primary">"Master Key"</span>. This key is generated from your unique 24-word <span className="font-semibold text-text-primary">Recovery Phrase</span> that you received during registration.
          </p>
          <p className="p-3 bg-accent/10 text-accent rounded-lg">
            <span className="font-bold">The most important concept:</span> Your Recovery Phrase is the only way to access your account if you forget your password or switch devices without access to an old one. We do not store it and cannot recover it for you.
          </p>
        </InfoSection>

        <InfoSection icon={<FiZap size={20} />} title="Key Storage on This Device">
          <p>
            For your convenience, your Master Key is stored on this device in a highly secure, encrypted bundle. This bundle is "locked" using your <span className="font-semibold text-text-primary">password</span>.
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li>When you log in, your password is used to unlock this bundle and load your keys into the secure session.</li>
            <li>Your password is never sent to our servers in a readable format.</li>
          </ul>
        </InfoSection>

        <InfoSection icon={<FiAlertTriangle size={20} />} title="Accessing Your Account on a New Device">
          <p>
            You have two ways to access your account on a new device:
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li>
              <span className="font-semibold text-text-primary">Link Device:</span> The easiest method. From a logged-in device, scan the QR code displayed on the new device. This process securely transfers your account keys, and you will be **logged in automatically** on the new device without needing to type a password.
            </li>
            <li>
              <span className="font-semibold text-text-primary">Restore:</span> If you don't have access to a logged-in device, use the "Restore" feature and enter your 24-word Recovery Phrase. You will be asked to create a **new password** for that specific device.
            </li>
          </ul>
        </InfoSection>

        <InfoSection icon={<FiHelpCircle size={20} />} title="Security Best Practices">
           <ul className="list-disc list-inside space-y-2">
            <li><span className="font-semibold text-text-primary">DO</span> store your Recovery Phrase in a very safe, offline location (e.g., a safe, physical note, or an encrypted password manager).</li>
            <li><span className="font-semibold text-text-primary">DO</span> verify your contacts' identities using the available security features before sharing sensitive information.</li>
            <li><span className="font-semibold text-destructive">DO NOT</span> share your password or Recovery Phrase with anyone. Ever.</li>
            <li><span className="font-semibold text-destructive">DO NOT</span> stay logged in on public or shared computers. Use the "Active Sessions" feature in Settings to log out remotely if needed.</li>
          </ul>
        </InfoSection>

      </div>
    </ModalBase>
  );
}