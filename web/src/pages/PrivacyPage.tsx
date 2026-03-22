import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FiArrowLeft, FiShield, FiLock, FiDatabase, FiCpu, FiGlobe, FiAlertTriangle } from 'react-icons/fi';
import SEO from '../components/SEO';
import { useTranslation, Trans } from 'react-i18next';

const Section = ({ title, icon: Icon, children, id }: { title: string; icon: React.ElementType; children: React.ReactNode; id: string }) => (
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
  const { t } = useTranslation(['privacy']);
  const [activeSection, setActiveSection] = useState('privacy');
  const navigate = useNavigate();

  const scrollTo = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  const techArticleSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "headline": "NYX Security Architecture & Zero-Knowledge Protocol",
    "alternativeHeadline": "How NYX protects metadata without storing user identities",
    "author": {
        "@type": "Organization",
        "name": "NYX Project"
    },
    "keywords": "Signal Protocol, Argon2, Zero-Knowledge, End-to-End Encryption, Privacy",
    "articleBody": "NYX uses a Double Ratchet algorithm...",
    "datePublished": "2026-03-01"
  });

  return (
    <div className="min-h-screen bg-bg-main text-text-primary font-sans selection:bg-accent selection:text-white">
      <SEO 
        title="Legal & Privacy | NYX" 
        description="Read about our Zero-Knowledge architecture, commercial licensing, and how NYX protects your data." 
        canonicalUrl="/privacy" 
        schemaMarkup={techArticleSchema}
      />
      
      {/* Header */}
      <header className="sticky top-0 z-50 bg-bg-surface/80 backdrop-blur-xl border-b border-white/5 shadow-sm">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <button 
            onClick={() => navigate(-1)} 
            className="flex items-center gap-2 text-text-secondary hover:text-accent transition-colors text-sm font-bold tracking-wide uppercase"
          >
            <FiArrowLeft size={16} /> {t('privacy:back')}
          </button>
          <div className="font-mono text-[10px] text-text-secondary uppercase tracking-[0.2em] flex items-center gap-2">
            <FiShield className="text-accent" /> {t('privacy:title')}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12 flex flex-col md:flex-row gap-12">
        {/* Sidebar Nav */}
        <aside className="md:w-64 flex-shrink-0 hidden md:block">
          <nav className="sticky top-28 space-y-2">
            {[
              { id: 'privacy', label: t('privacy:nav.privacy') },
              { id: 'terms', label: t('privacy:nav.terms') },
              { id: 'licensing', label: t('privacy:nav.licensing') },
              { id: 'cookies', label: t('privacy:nav.cookies') },
              { id: 'ai', label: t('privacy:nav.ai') },
              { id: 'security', label: t('privacy:nav.security') },
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
            <h1 className="text-4xl sm:text-5xl font-black mb-4 tracking-tighter bg-gradient-to-r from-white to-text-secondary bg-clip-text text-transparent">{t('privacy:title')}</h1>
            <p className="text-lg text-text-secondary max-w-2xl">
              {t('privacy:subtitle')}
            </p>
            <div className="mt-6 inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-accent/10 text-accent text-xs font-mono font-bold border border-accent/20">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse shadow-[0_0_8px_rgba(var(--color-accent),0.8)]"></span>
              {t('privacy:last_updated')}
            </div>
          </div>

          <Section id="privacy" title={t('privacy:privacy.title')} icon={FiLock}>
            <p className="text-lg text-text-primary font-medium mb-4">
              {t('privacy:privacy.intro')}
            </p>
            <h3 className="text-lg font-bold text-text-primary mt-8 mb-3 border-b border-white/5 pb-2">{t('privacy:privacy.minimization_title')}</h3>
            <ul className="list-disc pl-5 space-y-3">
              <li><Trans i18nKey="privacy:privacy.minimization_1"><strong>Blind Identity Protocol:</strong> We do not store your raw username, email, or phone number. We utilize client-side Argon2id hashing. The server only stores a cryptographic hash (`usernameHash`), rendering your identity mathematically irreversible to us.</Trans></li>
              <li><Trans i18nKey="privacy:privacy.minimization_2"><strong>Encrypted Metadata:</strong> Your display name, bio, and avatar are symmetrically encrypted on your device. To our infrastructure, your profile is an opaque blob of ciphertext.</Trans></li>
              <li><Trans i18nKey="privacy:privacy.minimization_3"><strong>E2EE Communication:</strong> All direct messages, voice notes, and file attachments are End-to-End Encrypted using the Signal Protocol (Double Ratchet). We act solely as a blind relay network.</Trans></li>
            </ul>

            <h3 className="text-lg font-bold text-text-primary mt-8 mb-3 border-b border-white/5 pb-2">{t('privacy:privacy.logging_title')}</h3>
            <p>{t('privacy:privacy.logging_desc')}</p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li>{t('privacy:privacy.logging_1')}</li>
              <li>{t('privacy:privacy.logging_2')}</li>
              <li>{t('privacy:privacy.logging_3')}</li>
            </ul>
          </Section>

          <Section id="terms" title={t('privacy:terms.title')} icon={FiGlobe}>
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5 mb-6">
              <h4 className="flex items-center gap-2 text-red-400 font-bold mb-2">
                <FiAlertTriangle /> {t('privacy:terms.liability_title')}
              </h4>
              <p className="text-sm text-red-200/80 m-0">
                <Trans i18nKey="privacy:terms.liability_desc">
                  NYX is provided "AS IS", without warranty of any kind. The maintainers shall not be held liable for any data loss, compromised keys, or service interruptions. You are solely responsible for managing your cryptographic Recovery Phrase. <strong>If you lose your password and Recovery Phrase, your account and data are permanently inaccessible. We cannot bypass our own encryption.</strong>
                </Trans>
              </p>
            </div>
            
            <ul className="list-disc pl-5 space-y-4">
              <li><Trans i18nKey="privacy:terms.gating"><strong>Trust-Tier Gating:</strong> To protect the network, unverified accounts are placed in a restricted "Sandbox Mode". Full capabilities require biometric hardware verification or cryptographic Proof-of-Work.</Trans></li>
              <li><Trans i18nKey="privacy:terms.abuse"><strong>Zero-Tolerance Abuse Policy:</strong> You agree not to utilize the NYX network for illicit activities, automated API abuse (botting), or distributing malware. Violations will result in immediate network bans.</Trans></li>
            </ul>
          </Section>

          <Section id="licensing" title={t('privacy:licensing.title')} icon={FiShield}>
            <p>
              <Trans i18nKey="privacy:licensing.intro">
                The NYX source code is proudly open-source and fiercely protected under the <strong>GNU Affero General Public License v3.0 (AGPL-3.0)</strong>.
              </Trans>
            </p>
            <h3 className="text-lg font-bold text-text-primary mt-6 mb-3">{t('privacy:licensing.agpl_title')}</h3>
            <p>
              <Trans i18nKey="privacy:licensing.agpl_desc">
                If you modify the NYX codebase and allow users to interact with it over a network (e.g., hosting it as a SaaS), you are legally obligated to release your modified source code to the public. <strong>Closed-source SaaS deployments of NYX under this license are strictly prohibited and constitute copyright infringement.</strong>
              </Trans>
            </p>
            
            <div className="bg-bg-surface border border-white/10 rounded-xl p-5 mt-6">
              <h4 className="font-bold text-text-primary mb-2">{t('privacy:licensing.commercial_title')}</h4>
              <p className="text-sm mb-4">
                {t('privacy:licensing.commercial_desc')}
              </p>
              <a href="https://github.com/h4nzs/nyx-chat" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-xs font-bold bg-white text-black px-4 py-2 rounded-lg hover:bg-gray-200 transition-colors">
                {t('privacy:licensing.contact_btn')}
              </a>
            </div>
          </Section>

          <Section id="cookies" title={t('privacy:cookies.title')} icon={FiDatabase}>
            <p className="mb-4">{t('privacy:cookies.intro')}</p>
            
            <div className="overflow-x-auto rounded-xl border border-white/5 shadow-sm">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-black/20 text-text-secondary text-xs uppercase tracking-wider">
                  <tr>
                    <th className="p-4 font-bold">{t('privacy:cookies.table_type')}</th>
                    <th className="p-4 font-bold">{t('privacy:cookies.table_item')}</th>
                    <th className="p-4 font-bold">{t('privacy:cookies.table_purpose')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-text-secondary">
                  <tr className="hover:bg-white/5 transition-colors">
                    <td className="p-4"><span className="px-2 py-1 rounded bg-blue-500/10 text-blue-400 text-xs">HttpOnly Cookie</span></td>
                    <td className="p-4 font-mono text-accent">at / rt / csrf</td>
                    <td className="p-4">{t('privacy:cookies.cookie_desc')}</td>
                  </tr>
                  <tr className="hover:bg-white/5 transition-colors">
                    <td className="p-4"><span className="px-2 py-1 rounded bg-purple-500/10 text-purple-400 text-xs">IndexedDB</span></td>
                    <td className="p-4 font-mono text-accent">nyx_vault / keys</td>
                    <td className="p-4">{t('privacy:cookies.idb_keys_desc')}</td>
                  </tr>
                  <tr className="hover:bg-white/5 transition-colors">
                    <td className="p-4"><span className="px-2 py-1 rounded bg-purple-500/10 text-purple-400 text-xs">IndexedDB</span></td>
                    <td className="p-4 font-mono text-accent">shadow_vault</td>
                    <td className="p-4">{t('privacy:cookies.idb_vault_desc')}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="ai" title={t('privacy:ai.title')} icon={FiCpu}>
            <p><Trans i18nKey="privacy:ai.intro">NYX operates with <strong>Zero Telemetry</strong>. We do not track your clicks, screen time, or feature usage.</Trans></p>
            
            <h3 className="text-lg font-bold text-text-primary mt-6 mb-3">{t('privacy:ai.smart_reply_title')}</h3>
            <p><Trans i18nKey="privacy:ai.smart_reply_desc">We provide an experimental "Smart Reply" feature utilizing the Google Gemini API. This feature is <strong>strictly Opt-In</strong>.</Trans></p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li>{t('privacy:ai.smart_reply_1')}</li>
              <li>{t('privacy:ai.smart_reply_2')}</li>
              <li>{t('privacy:ai.smart_reply_3')}</li>
            </ul>
          </Section>

          <Section id="security" title={t('privacy:security.title')} icon={FiShield}>
            <p>{t('privacy:security.intro')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
              <div className="bg-bg-surface p-4 rounded-xl border border-white/5">
                <h4 className="font-bold text-text-primary mb-1">{t('privacy:security.signal_title')}</h4>
                <p className="text-xs text-text-secondary">{t('privacy:security.signal_desc')}</p>
              </div>
              <div className="bg-bg-surface p-4 rounded-xl border border-white/5">
                <h4 className="font-bold text-text-primary mb-1">{t('privacy:security.webauthn_title')}</h4>
                <p className="text-xs text-text-secondary">{t('privacy:security.webauthn_desc')}</p>
              </div>
              <div className="bg-bg-surface p-4 rounded-xl border border-white/5">
                <h4 className="font-bold text-text-primary mb-1">{t('privacy:security.memory_title')}</h4>
                <p className="text-xs text-text-secondary">{t('privacy:security.memory_desc')}</p>
              </div>
              <div className="bg-bg-surface p-4 rounded-xl border border-white/5">
                <h4 className="font-bold text-text-primary mb-1">{t('privacy:security.migration_title')}</h4>
                <p className="text-xs text-text-secondary">{t('privacy:security.migration_desc')}</p>
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
          <p className="mt-2 text-xs opacity-50 font-mono">&quot;In an era of total surveillance, obfuscation is the only true liberty.&quot;</p>
        </div>
      </footer>
    </div>
  );
}
