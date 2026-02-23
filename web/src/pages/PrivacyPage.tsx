import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FiArrowLeft, FiShield, FiLock, FiDatabase, FiCpu, FiGlobe } from 'react-icons/fi';
import { motion } from 'framer-motion';

const Section = ({ title, icon: Icon, children, id }: { title: string; icon: any; children: React.ReactNode; id: string }) => (
  <section id={id} className="mb-12 scroll-mt-24">
    <div className="flex items-center gap-3 mb-6">
      <div className="p-2 rounded-lg bg-accent/10 text-accent">
        <Icon size={24} />
      </div>
      <h2 className="text-2xl font-bold text-text-primary">{title}</h2>
    </div>
    <div className="prose dark:prose-invert max-w-none text-text-secondary">
      {children}
    </div>
  </section>
);

export default function PrivacyPage() {
  const [activeSection, setActiveSection] = useState('privacy');
  const navigate = useNavigate();

  const scrollTo = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-bg-main text-text-primary font-sans selection:bg-accent selection:text-white">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-bg-main/80 backdrop-blur-md border-b border-white/5">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <button 
            onClick={() => navigate(-1)} 
            className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium"
          >
            <FiArrowLeft /> Back to App
          </button>
          <div className="font-mono text-xs text-text-secondary uppercase tracking-widest">
            Legal & Compliance
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12 flex flex-col md:flex-row gap-12">
        {/* Sidebar Nav */}
        <aside className="md:w-64 flex-shrink-0">
          <nav className="sticky top-24 space-y-1">
            {[
              { id: 'privacy', label: 'Privacy Policy' },
              { id: 'terms', label: 'Terms of Service' },
              { id: 'cookies', label: 'Cookie Policy' },
              { id: 'ai', label: 'AI & Smart Features' },
              { id: 'security', label: 'Security Architecture' },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => scrollTo(item.id)}
                className={`
                  w-full text-left px-4 py-3 rounded-lg text-sm font-medium transition-all
                  ${activeSection === item.id 
                    ? 'bg-accent text-white shadow-lg' 
                    : 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'}
                `}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="mb-12">
            <h1 className="text-4xl font-black mb-4 tracking-tight">Legal & Privacy Center</h1>
            <p className="text-lg text-text-secondary">
              Transparency about how we handle your data, secure your messages, and comply with global standards.
            </p>
            <div className="mt-4 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-500/10 text-green-500 text-xs font-bold border border-green-500/20">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
              Last Updated: February 10, 2026
            </div>
          </div>

          <Section id="privacy" title="Privacy Policy" icon={FiLock}>
            <p>
              At NYX, we prioritize your privacy above all else. Our architecture is designed to minimize the data we know about you.
            </p>
            <h3 className="text-lg font-bold text-text-primary mt-6 mb-3">1. Data We Collect</h3>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Account Information:</strong> Username, display name, email address (for verification), and avatar image.</li>
              <li><strong>Cryptographic Keys:</strong> Public keys (Identity Keys, Signed Pre-keys) are stored on our servers to enable others to start encrypted chats with you. Your <strong>Private Keys</strong> are stored as an encrypted blob that <strong>only you</strong> can decrypt with your password.</li>
              <li><strong>Connection Data:</strong> IP address and User Agent strings are temporarily logged for security purposes (Rate Limiting, Refresh Tokens) to prevent abuse.</li>
              <li><strong>Messages:</strong> Your messages are <strong>End-to-End Encrypted (E2EE)</strong>. Our servers only relay encrypted blobs ("ciphertext"). We cannot read, analyze, or modify your messages. Messages are stored on your device (IndexedDB) and temporarily in our database until delivered or for sync purposes.</li>
            </ul>

            <h3 className="text-lg font-bold text-text-primary mt-6 mb-3">2. Third-Party Processors</h3>
            <p>We use trusted third-party services for specific infrastructure needs:</p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li><strong>Cloudflare:</strong> For DDoS protection, CDN, and Turnstile (CAPTCHA) verification.</li>
              <li><strong>Google Analytics (GA4):</strong> For anonymous usage statistics to improve the app experience.</li>
              <li><strong>DiceBear:</strong> For generating default user avatars.</li>
              <li><strong>Google Gemini:</strong> For the optional "Smart Reply" feature (see AI section).</li>
            </ul>
          </Section>

          <Section id="terms" title="Terms of Service" icon={FiGlobe}>
            <p>By using NYX, you agree to the following terms:</p>
            <ul className="list-disc pl-5 space-y-2 mt-4">
              <li><strong>Acceptable Use:</strong> You agree not to use NYX for illegal activities, harassment, spamming, or distributing malware.</li>
              <li><strong>Account Security:</strong> You are responsible for keeping your password and recovery phrase safe. Because we do not store your raw password or private keys, <strong>we cannot recover your account if you lose both your password and recovery phrase.</strong></li>
              <li><strong>Termination:</strong> We reserve the right to ban accounts that violate these terms or abuse the service API (e.g., botting).</li>
              <li><strong>Disclaimer:</strong> The service is provided "as is". While we strive for maximum security, no system is 100% invulnerable.</li>
            </ul>
          </Section>

          <Section id="cookies" title="Cookie Policy" icon={FiDatabase}>
            <p>We use cookies strictly for authentication and security.</p>
            
            <div className="overflow-hidden rounded-xl border border-white/10 mt-6">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg-surface text-text-primary">
                  <tr>
                    <th className="p-4 font-bold">Name</th>
                    <th className="p-4 font-bold">Purpose</th>
                    <th className="p-4 font-bold">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <tr>
                    <td className="p-4 font-mono text-accent">at</td>
                    <td className="p-4">Access Token (Short-lived authentication)</td>
                    <td className="p-4">Essential / HttpOnly</td>
                  </tr>
                  <tr>
                    <td className="p-4 font-mono text-accent">rt</td>
                    <td className="p-4">Refresh Token (Session persistence)</td>
                    <td className="p-4">Essential / HttpOnly</td>
                  </tr>
                  <tr>
                    <td className="p-4 font-mono text-accent">x-csrf-token</td>
                    <td className="p-4">Protects against Cross-Site Request Forgery attacks</td>
                    <td className="p-4">Security</td>
                  </tr>
                  <tr>
                    <td className="p-4 font-mono text-accent">webauthn_challenge</td>
                    <td className="p-4">Temporary challenge for Biometric login</td>
                    <td className="p-4">Security</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="ai" title="AI & Smart Features" icon={FiCpu}>
            <p>
              NYX includes an experimental <strong>Smart Reply</strong> feature powered by Google Gemini.
            </p>
            <div className="bg-accent/5 border-l-4 border-accent p-4 rounded-r-lg mt-4">
              <h4 className="font-bold text-accent mb-1">Privacy Guarantee</h4>
              <p className="text-sm">
                This feature is <strong>Opt-In</strong> (disabled by default). When enabled:
              </p>
              <ul className="list-disc pl-5 space-y-1 mt-2 text-sm">
                <li>Your incoming message text is decrypted on your device.</li>
                <li>The text is sent securely to Google Gemini via our server proxy for analysis.</li>
                <li>Our server <strong>does not store</strong> this text; it is strictly a pass-through.</li>
                <li>Google processes the text to generate reply suggestions and discards it (per their API terms for ephemeral processing).</li>
              </ul>
            </div>
          </Section>

          <Section id="security" title="Security Architecture" icon={FiShield}>
            <p>
              We are transparent about our security model.
            </p>
            <h3 className="text-lg font-bold text-text-primary mt-6 mb-3">Encryption Protocol</h3>
            <p>
              We implement the <strong>Signal Protocol</strong> (X3DH + Double Ratchet) using <code>libsodium</code>.
            </p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li><strong>Keys:</strong> Curve25519 for Identity and Pre-keys.</li>
              <li><strong>Cipher:</strong> XChaCha20-Poly1305 for message encryption.</li>
              <li><strong>Hash:</strong> Argon2id for password hashing and key derivation.</li>
            </ul>

            <h3 className="text-lg font-bold text-text-primary mt-6 mb-3">Key Storage</h3>
            <p>
              Your private keys are encrypted with your password and stored in <strong>IndexedDB</strong> within your browser. 
              A backup copy (also encrypted with your password) is stored on our server to allow you to login from multiple devices. 
              <strong>We never possess the key to decrypt this backup.</strong>
            </p>
          </Section>

        </div>
      </main>

      <footer className="border-t border-white/5 py-12 bg-bg-surface">
        <div className="max-w-5xl mx-auto px-6 text-center text-text-secondary text-sm">
          <p>&copy; {new Date().getFullYear()} NYX Secure Messenger. All rights reserved.</p>
          <p className="mt-2 opacity-50">Built with privacy as a fundamental right, not a feature.</p>
        </div>
      </footer>
    </div>
  );
}
