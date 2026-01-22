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
            <h2 className="text-xl font-semibold text-text-primary mb-3">My Messages Fail to Decrypt or Show "[Error]"</h2>
            <p className="mb-2">
              This is a normal part of end-to-end encryption security. Session encryption keys change frequently to maintain security.
            </p>
            <p className="mb-2">
              If you see messages like "[Failed to decrypt message]" or "[Requesting key to decrypt...]", it means the session key used to encrypt that message is not available on your device. This can happen if:
            </p>
            <ul className="list-disc list-inside ml-4 space-y-1">
              <li>You or your contact have generated new encryption keys (e.g., after reinstalling the app or restoring an account).</li>
              <li>The message was sent while you were offline, and the initial session key negotiation failed.</li>
            </ul>
            <h3 className="font-semibold text-text-primary mt-3">Solution:</h3>
            <p>
              Ask your contact to send a new message. This will force the creation of a new session key, which should allow subsequent messages to decrypt. For older messages that failed to decrypt, unfortunately, they cannot be recovered if the correct key is no longer available.
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">Why Do I Need to Restore My Account on a New Device?</h2>
            <p className="mb-2">
              For maximum security, your private encryption keys are stored only on your device, never on our servers.
            </p>
            <p className="mb-2">
              When you log in on a new device (or after clearing your browser data), that device does not have the keys required to encrypt or decrypt messages. Without these keys, E2EE functionality will not work.
            </p>
            <h3 className="font-semibold text-text-primary mt-3">Solution:</h3>
            <p>
              Use the 24-word Recovery Phrase you saved during registration to restore your keys on this new device. You can do this in Settings &gt; Key Management.
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">What is a 'Safety Number' and Why Does It Change?</h2>
            <p className="mb-2">
              A 'Safety Number' is a visual way to verify the identity of your contact. It's a short representation of both your and your contact's encryption keys.
            </p>
            <p className="mb-2">
              This number will change if you or your contact:
            </p>
            <ul className="list-disc list-inside ml-4 space-y-1">
              <li>Reinstall the application.</li>
              <li>Switch devices.</li>
              <li>Generate new encryption keys.</li>
            </ul>
            <h3 className="font-semibold text-text-primary mt-3">Solution:</h3>
            <p>
              If the Safety Number changes, re-verify with your contact through an out-of-band method (e.g., a phone call or video call) to ensure you are still communicating with the correct person and to prevent "man-in-the-middle" attacks.
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">I Forgot My Password AND My Recovery Phrase.</h2>
            <p className="mb-2">
              Because this application is designed with privacy as a top priority, we never have access to your password, private keys, or recovery phrase.
            </p>
            <h3 className="font-semibold text-text-primary mt-3">Solution:</h3>
            <p>
              Unfortunately, there is no way for us or anyone else to recover your account or messages in this case. You will need to create a new account. This is the trade-off for strong security and privacy.
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}