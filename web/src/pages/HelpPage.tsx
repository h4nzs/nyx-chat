import { Link } from 'react-router-dom';
import { FiChevronLeft, FiHelpCircle } from 'react-icons/fi';
import { useTranslation, Trans } from 'react-i18next';

import SEO from '../components/SEO';

// ...

export default function HelpPage() {
  const { t } = useTranslation(['help', 'common']);

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-bg-main text-text-primary p-4">
      <SEO title={t('help:title')} description="Get help with NYX E2EE chat, account recovery, and security features." canonicalUrl="/help" />
      <div className="w-full max-w-2xl card-neumorphic p-8 overflow-y-auto max-h-[90vh]">
        <div className="flex items-center gap-4 mb-6 pb-4 border-b border-border">
          <Link to="/settings" aria-label={t('help:back_settings')} className="touch-target p-2.5 rounded-full text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all">
            <FiChevronLeft size={24} />
          </Link>
          <FiHelpCircle className="text-accent text-3xl" />
          <h1 className="text-2xl font-bold text-text-primary">{t('help:title')}</h1>
        </div>

        <div className="space-y-6 text-text-secondary">

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">{t('help:move_account.title')}</h2>
            <p className="mb-2">
              {t('help:move_account.desc')}
            </p>
            <ul className="list-disc list-inside ml-4 space-y-2">
              <li>
                <span className="font-bold text-text-primary">{t('help:move_account.migration_label')}</span> <Trans i18nKey="help:move_account.migration_text"><span className="font-mono bg-bg-surface p-1 rounded">Settings &gt; Transfer to New Device</span></Trans>
              </li>
              <li>
                <span className="font-bold text-text-primary">{t('help:move_account.backup_label')}</span> <Trans i18nKey="help:move_account.backup_text"><span className="font-mono bg-bg-surface p-1 rounded">Settings &gt; Export Vault</span></Trans>
              </li>
            </ul>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">{t('help:sandbox_mode.title')}</h2>
            <p className="mb-2">
              <Trans i18nKey="help:sandbox_mode.desc">
                To prevent spam bots without collecting personal data (like phone numbers), new accounts start in <strong>Sandbox Mode</strong> with limited messaging quotas.
              </Trans>
            </p>
            <p>
              <Trans i18nKey="help:sandbox_mode.upgrade_text">
                You can upgrade to <strong>VIP Status</strong> instantly for free by verifying you are human. Go to <span className="font-mono bg-bg-surface p-1 rounded">Settings &gt; Upgrade to VIP</span> and choose either <strong>Biometric Verification</strong> (Fingerprint/FaceID) or <strong>Proof of Work</strong> (CPU Mining).
              </Trans>
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">{t('help:forgot_password.title')}</h2>
             <p className="mb-2">
              <Trans i18nKey="help:forgot_password.desc">
                Because we don&apos;t have your email, we cannot send you a reset link. You must use your <strong>Recovery Phrase</strong>.
              </Trans>
            </p>
            <ul className="list-disc list-inside ml-4 space-y-1">
              <li>{t('help:forgot_password.step1')}</li>
              <li>{t('help:forgot_password.step2')}</li>
              <li>{t('help:forgot_password.step3')}</li>
            </ul>
            <p className="mt-2 text-yellow-500 text-sm">
              <Trans i18nKey="help:forgot_password.warning">
                Note: Restoring from a phrase resets your identity keys. You will regain access to your account ID, but <strong>chat history will be lost</strong> unless you have a Vault Backup.
              </Trans>
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">{t('help:sync_issues.title')}</h2>
            <p className="mb-2">
              <Trans i18nKey="help:sync_issues.desc">
                NYX is <strong>Local-First</strong>. Messages live on your device, not the cloud. If you use NYX on multiple devices (e.g. Phone + Laptop), they act as independent clients.
              </Trans>
            </p>
            <p>
              {t('help:sync_issues.future_text')}
            </p>
          </section>

          <div className="border-b border-border my-6" />

          <section>
            <h2 className="text-xl font-semibold text-text-primary mb-3">{t('help:lost_phrase.title')}</h2>
            <p className="mb-2 font-semibold text-destructive">
              {t('help:lost_phrase.irrecoverable')}
            </p>
            <p>
              {t('help:lost_phrase.desc')}
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}
