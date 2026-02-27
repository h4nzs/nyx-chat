import { Link } from 'react-router-dom';
import { FiChevronLeft, FiHelpCircle } from 'react-icons/fi';

export default function HelpPage() {
  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-bg-main text-text-primary p-4">
      <div className="w-full max-w-2xl card-neumorphic p-8 overflow-y-auto max-h-[90vh]">
        <div className="flex items-center gap-4 mb-6 pb-4 border-b border-border">
          <Link to="/settings" aria-label="Back to Settings" className="touch-target p-2.5 rounded-full text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all">
            <FiChevronLeft size={24} />
          </Link>
          <FiHelpCircle className="text-accent text-3xl" />
          <h1 className="text-2xl font-bold text-text-primary">Help & FAQ</h1>
        </div>

        <div className="space-y-6 text-text-secondary">

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">How do I move my account to a new device?</h2>
            <p className="mb-2">
              Since NYX stores your keys and history locally for maximum privacy, you cannot simply log in to see old messages. You have two secure ways to move:
            </p>
            <ul className="list-disc list-inside ml-4 space-y-2">
              <li>
                <span className="font-bold text-text-primary">Device Migration (Recommended):</span> Go to <span className="font-mono bg-bg-surface p-1 rounded">Settings &gt; Transfer to New Device</span>. This creates a secure, direct tunnel to your new phone via QR code.
              </li>
              <li>
                <span className="font-bold text-text-primary">Vault Backup:</span> Go to <span className="font-mono bg-bg-surface p-1 rounded">Settings &gt; Export Vault</span>. Save the `.nyxvault` file and import it on your new device login screen.
              </li>
            </ul>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">Why is my account "Sandboxed"?</h2>
            <p className="mb-2">
              To prevent spam bots without collecting personal data (like phone numbers), new accounts start in <strong>Sandbox Mode</strong> with limited messaging quotas.
            </p>
            <p>
              You can upgrade to <strong>VIP Status</strong> instantly for free by verifying you are human. Go to <span className="font-mono bg-bg-surface p-1 rounded">Settings &gt; Upgrade to VIP</span> and choose either <strong>Biometric Verification</strong> (Fingerprint/FaceID) or <strong>Proof of Work</strong> (CPU Mining).
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">I forgot my password. What do I do?</h2>
             <p className="mb-2">
              Because we don't have your email, we cannot send you a reset link. You must use your <strong>Recovery Phrase</strong>.
            </p>
            <ul className="list-disc list-inside ml-4 space-y-1">
              <li>On the login screen, click "Restore from phrase".</li>
              <li>Enter your 24-word Recovery Phrase to prove your identity.</li>
              <li>Set a new password.</li>
            </ul>
            <p className="mt-2 text-yellow-500 text-sm">
              Note: Restoring from a phrase resets your identity keys. You will regain access to your account ID, but <strong>chat history will be lost</strong> unless you have a Vault Backup.
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">Why are my messages not syncing?</h2>
            <p className="mb-2">
              NYX is <strong>Local-First</strong>. Messages live on your device, not the cloud. If you use NYX on multiple devices (e.g. Phone + Laptop), they act as independent clients.
            </p>
            <p>
              We are working on a secure "Sync Protocol" for the future, but currently, history does not automatically sync between devices to ensure zero-knowledge privacy.
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">What if I lose my Recovery Phrase?</h2>
            <p className="mb-2 font-semibold text-destructive">
              Your account is mathematically irrecoverable.
            </p>
            <p>
              We do not store your phrase or password. If you lose them, no one on Earth—including us—can decrypt your data. Please write down your phrase and store it safely offline.
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}