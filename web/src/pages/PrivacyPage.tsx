import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FiArrowLeft, FiShield, FiLock, FiDatabase, FiCpu, FiGlobe, FiAlertTriangle } from 'react-icons/fi';
import SEO from '../components/SEO';

const Section = ({ title, icon: Icon, children, id }: { title: string; icon: any; children: React.ReactNode; id: string }) => (
  <section id={id} className="mb-12 scroll-mt-24">
    <div className="flex items-center gap-3 mb-6">
      <div className="p-2 rounded-lg bg-accent/10 text-accent shadow-neumorphic-concave">
        <Icon size={24} />
      </div>
      <h2 className="text-2xl font-bold text-text-primary tracking-tight">{title}</h2>
    </div>
    <div className="prose dark:prose-invert max-w-none text-text-secondary leading-relaxed">
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
      <SEO title="Legal & Privacy | NYX" description="Read about our Zero-Knowledge architecture, commercial licensing, and how NYX protects your data." canonicalUrl="/privacy" />
      
      {/* Header */}
      <header className="sticky top-0 z-50 bg-bg-surface/80 backdrop-blur-xl border-b border-white/5 shadow-sm">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <button 
            onClick={() => navigate(-1)} 
            className="flex items-center gap-2 text-text-secondary hover:text-accent transition-colors text-sm font-bold tracking-wide uppercase"
          >
            <FiArrowLeft size={16} /> Back to Hub
          </button>
          <div className="font-mono text-[10px] text-text-secondary uppercase tracking-[0.2em] flex items-center gap-2">
            <FiShield className="text-accent" /> Legal & Compliance
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12 flex flex-col md:flex-row gap-12">
        {/* Sidebar Nav */}
        <aside className="md:w-64 flex-shrink-0 hidden md:block">
          <nav className="sticky top-28 space-y-2">
            {[
              { id: 'privacy', label: 'Privacy Policy' },
              { id: 'terms', label: 'Terms of Service' },
              { id: 'licensing', label: 'Software Licensing' },
              { id: 'cookies', label: 'Cookie Policy' },
              { id: 'ai', label: 'AI & Telemetry' },
              { id: 'security', label: 'Security Architecture' },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => scrollTo(item.id)}
                className={`
                  w-full text-left px-4 py-3 rounded-xl text-sm font-bold transition-all duration-300
                  ${activeSection === item.id 
                    ? 'bg-accent/10 border border-accent/20 text-accent shadow-inner' 
                    : 'text-text-secondary hover:bg-white/5 hover:text-text-primary border border-transparent'}
                `}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="mb-16">
            <h1 className="text-4xl sm:text-5xl font-black mb-4 tracking-tighter bg-gradient-to-r from-white to-text-secondary bg-clip-text text-transparent">Legal & Privacy Center</h1>
            <p className="text-lg text-text-secondary max-w-2xl">
              Absolute transparency regarding our Zero-Knowledge data handling, cryptographic protocols, and software licensing terms.
            </p>
            <div className="mt-6 inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-accent/10 text-accent text-xs font-mono font-bold border border-accent/20">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse shadow-[0_0_8px_rgba(var(--color-accent),0.8)]"></span>
              Last Updated: March 2026
            </div>
          </div>

          <Section id="privacy" title="Privacy Policy" icon={FiLock}>
            <p className="text-lg text-text-primary font-medium mb-4">
              Our core directive: If we don't have your data, no one can demand it from us.
            </p>
            <h3 className="text-lg font-bold text-text-primary mt-8 mb-3 border-b border-white/5 pb-2">1. Data Minimization & Cryptography</h3>
            <ul className="list-disc pl-5 space-y-3">
              <li><strong>Blind Identity Protocol:</strong> We do not store your raw username, email, or phone number. We utilize client-side Argon2id hashing. The server only stores a cryptographic hash (`usernameHash`), rendering your identity mathematically irreversible to us.</li>
              <li><strong>Encrypted Metadata:</strong> Your display name, bio, and avatar are symmetrically encrypted on your device. To our infrastructure, your profile is an opaque blob of ciphertext.</li>
              <li><strong>E2EE Communication:</strong> All direct messages, voice notes, and file attachments are End-to-End Encrypted using the Signal Protocol (Double Ratchet). We act solely as a blind relay network.</li>
            </ul>

            <h3 className="text-lg font-bold text-text-primary mt-8 mb-3 border-b border-white/5 pb-2">2. Ephemeral Network Logging</h3>
            <p>To maintain network integrity and prevent DDoS/Botnet attacks, we temporarily process:</p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li>IP addresses (irreversibly hashed upon connection).</li>
              <li>WebSocket connection timestamps (swept automatically from Redis).</li>
              <li>Encrypted offline message queues (automatically purged upon successful delivery to the recipient).</li>
            </ul>
          </Section>

          <Section id="terms" title="Terms of Service" icon={FiGlobe}>
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5 mb-6">
              <h4 className="flex items-center gap-2 text-red-400 font-bold mb-2">
                <FiAlertTriangle /> Critical Disclaimer of Liability
              </h4>
              <p className="text-sm text-red-200/80 m-0">
                NYX is provided "AS IS", without warranty of any kind. The maintainers shall not be held liable for any data loss, compromised keys, or service interruptions. You are solely responsible for managing your cryptographic Recovery Phrase. <strong>If you lose your password and Recovery Phrase, your account and data are permanently inaccessible. We cannot bypass our own encryption.</strong>
              </p>
            </div>
            
            <ul className="list-disc pl-5 space-y-4">
              <li><strong>Trust-Tier Gating:</strong> To protect the network, unverified accounts are placed in a restricted "Sandbox Mode". Full capabilities require biometric hardware verification or cryptographic Proof-of-Work.</li>
              <li><strong>Zero-Tolerance Abuse Policy:</strong> You agree not to utilize the NYX network for illicit activities, automated API abuse (botting), or distributing malware. Violations will result in immediate network bans.</li>
            </ul>
          </Section>

          <Section id="licensing" title="Software Licensing & Enterprise" icon={FiShield}>
            <p>
              The NYX source code is proudly open-source and fiercely protected under the <strong>GNU Affero General Public License v3.0 (AGPL-3.0)</strong>.
            </p>
            <h3 className="text-lg font-bold text-text-primary mt-6 mb-3">The AGPL-3.0 Constraint</h3>
            <p>
              If you modify the NYX codebase and allow users to interact with it over a network (e.g., hosting it as a SaaS), you are legally obligated to release your modified source code to the public. <strong>Closed-source SaaS deployments of NYX under this license are strictly prohibited and constitute copyright infringement.</strong>
            </p>
            
            <div className="bg-bg-surface border border-white/10 rounded-xl p-5 mt-6">
              <h4 className="font-bold text-text-primary mb-2">Commercial Dual-Licensing</h4>
              <p className="text-sm mb-4">
                For corporations, enterprises, or startups wishing to integrate NYX into a proprietary, closed-source product without the AGPL obligations, we offer a Commercial License.
              </p>
              <a href="https://github.com/h4nzs/chat-lite" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-xs font-bold bg-white text-black px-4 py-2 rounded-lg hover:bg-gray-200 transition-colors">
                Contact Command for Enterprise Pricing
              </a>
            </div>
          </Section>

          <Section id="cookies" title="Cookie & Storage Policy" icon={FiDatabase}>
            <p className="mb-4">We do not use tracking, advertising, or third-party analytics cookies. Local storage is used strictly for cryptographic persistence and authentication.</p>
            
            <div className="overflow-x-auto rounded-xl border border-white/5 shadow-sm">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-black/20 text-text-secondary text-xs uppercase tracking-wider">
                  <tr>
                    <th className="p-4 font-bold">Storage Type</th>
                    <th className="p-4 font-bold">Item</th>
                    <th className="p-4 font-bold">Purpose</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-text-secondary">
                  <tr className="hover:bg-white/5 transition-colors">
                    <td className="p-4"><span className="px-2 py-1 rounded bg-blue-500/10 text-blue-400 text-xs">HttpOnly Cookie</span></td>
                    <td className="p-4 font-mono text-accent">at / rt / csrf</td>
                    <td className="p-4">Secure authentication & session persistence.</td>
                  </tr>
                  <tr className="hover:bg-white/5 transition-colors">
                    <td className="p-4"><span className="px-2 py-1 rounded bg-purple-500/10 text-purple-400 text-xs">IndexedDB</span></td>
                    <td className="p-4 font-mono text-accent">nyx_vault / keys</td>
                    <td className="p-4">Local storage of your encrypted Private Keys.</td>
                  </tr>
                  <tr className="hover:bg-white/5 transition-colors">
                    <td className="p-4"><span className="px-2 py-1 rounded bg-purple-500/10 text-purple-400 text-xs">IndexedDB</span></td>
                    <td className="p-4 font-mono text-accent">shadow_vault</td>
                    <td className="p-4">Local storage of your E2EE chat history.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="ai" title="AI & Telemetry" icon={FiCpu}>
            <p>NYX operates with <strong>Zero Telemetry</strong>. We do not track your clicks, screen time, or feature usage.</p>
            
            <h3 className="text-lg font-bold text-text-primary mt-6 mb-3">Smart Reply (Optional AI)</h3>
            <p>We provide an experimental "Smart Reply" feature utilizing the Google Gemini API. This feature is <strong>strictly Opt-In</strong>.</p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li>Messages are decrypted locally before being sent to the AI.</li>
              <li>The NYX Server acts as a blind proxy; it does not log the prompt or the AI's response.</li>
              <li>Data processed by the Gemini API is ephemeral and is not used to train foundational AI models, per Google's enterprise API terms.</li>
            </ul>
          </Section>

          <Section id="security" title="Security Architecture" icon={FiShield}>
            <p>Our cryptographic implementations are open for audit.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
              <div className="bg-bg-surface p-4 rounded-xl border border-white/5">
                <h4 className="font-bold text-text-primary mb-1">Signal Protocol</h4>
                <p className="text-xs text-text-secondary">X3DH key agreement and Double Ratchet forward/backward secrecy via libsodium (XChaCha20-Poly1305).</p>
              </div>
              <div className="bg-bg-surface p-4 rounded-xl border border-white/5">
                <h4 className="font-bold text-text-primary mb-1">WebAuthn PRF</h4>
                <p className="text-xs text-text-secondary">Passwordless biometric vault decryption leveraging hardware secure enclaves (Secure Enclave/TPM).</p>
              </div>
              <div className="bg-bg-surface p-4 rounded-xl border border-white/5">
                <h4 className="font-bold text-text-primary mb-1">Volatile Memory</h4>
                <p className="text-xs text-text-secondary">Cryptographic keys are wiped from RAM (`sodium.memzero`) immediately after decryption cycles.</p>
              </div>
              <div className="bg-bg-surface p-4 rounded-xl border border-white/5">
                <h4 className="font-bold text-text-primary mb-1">Peer-to-Peer Migration</h4>
                <p className="text-xs text-text-secondary">Device migration uses an encrypted WebSocket tunnel. The server relays chunks blindly without key access.</p>
              </div>
            </div>
          </Section>

        </div>
      </main>

      <footer className="border-t border-white/5 py-12 bg-black/20">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <div className="inline-flex items-center gap-2 text-text-secondary font-mono text-xs uppercase tracking-widest mb-4">
            <FiShield /> Military-Grade Privacy
          </div>
          <p className="text-text-secondary text-sm">&copy; {new Date().getFullYear()} NYX. All rights reserved under AGPL-3.0.</p>
          <p className="mt-2 text-xs opacity-50 font-mono">"In an era of total surveillance, obfuscation is the only true liberty."</p>
        </div>
      </footer>
    </div>
  );
}
