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
            <h2 className="text-xl font-semibold text-text-primary mb-3">What's the easiest way to use my account on a new device?</h2>
            <p className="mb-2">
              The best and easiest method is to use the <span className="font-bold text-text-primary">Link Device</span> feature.
            </p>
            <ul className="list-disc list-inside ml-4 space-y-1">
              <li>On your new, logged-out device, click "Link Device" on the login screen. It will show a QR code.</li>
              <li>On your existing, logged-in device, go to <span className="font-mono bg-bg-main p-1 rounded">Settings &gt; Link Device</span> and scan the QR code.</li>
            </ul>
            <p className="mt-2">
              Your account will be securely transferred, and you will be logged in automatically on the new device.
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">When should I use my 24-word Recovery Phrase?</h2>
            <p className="mb-2">
              Your Recovery Phrase is your ultimate backup. You should only need it in one situation: <span className="font-bold text-text-primary">when you've lost access to ALL of your logged-in devices</span> (for example, if you lost your phone and have no other active sessions).
            </p>
            <p>
              It allows you to regenerate your Master Key from scratch on a new device.
            </p>
          </section>
          
          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">I forgot my password, but I have my Recovery Phrase. What do I do?</h2>
             <p className="mb-2">
              You can regain access by using the "Restore" feature.
            </p>
            <ul className="list-disc list-inside ml-4 space-y-1">
              <li>First, ensure you are logged out.</li>
              <li>On the login screen, click "Restore Account".</li>
              <li>Enter your 24-word Recovery Phrase and choose a <span className="font-bold text-text-primary">new password</span> for this device.</li>
            </ul>
            <p className="mt-2">
              After restoring, you can log in with your email/username and the new password you just set.
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">Why are my old messages not on my new device?</h2>
            <p className="mb-2">
              This is a feature of the end-to-end encryption design. For your privacy, message contents are only stored on the devices involved in the conversation, not on our servers.
            </p>
            <p>
              When you set up a new device, it will only start receiving new messages sent after it has been linked or restored. It cannot recover the history from other devices.
            </p>
          </section>

          <div className="border-b border-border my-6" />
          
          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">Some messages show "[Failed to decrypt]". Why?</h2>
            <p className="mb-2">
              This can happen in E2EE chats when the session keys between you and your contact go out of sync. This usually occurs if one of you has reinstalled the app, restored from a phrase, or linked a new device, which generates new encryption keys.
            </p>
            <h3 className="font-semibold text-text-primary mt-3">Solution:</h3>
            <p>
              Ask your contact to send a new message in the chat. This forces both your apps to establish a new, secure session key, and subsequent messages should decrypt correctly.
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">What if I lose BOTH my password and my Recovery Phrase?</h2>
            <p className="mb-2 font-semibold text-destructive">
              Unfortunately, in this case, your account is permanently irrecoverable.
            </p>
            <p>
              Because of the privacy-first design, we never have access to your password, keys, or phrase. There is no "forgot password" link, and we have no way to access your account data. This is the trade-off for ensuring no one but you can ever access your conversations.
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}