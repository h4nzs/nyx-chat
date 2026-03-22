import { useState } from 'react';
import ModalBase from './ui/ModalBase';
import { useAuthStore } from '@store/auth';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@lib/api';
import { FiKey, FiShield, FiSmile, FiCoffee } from 'react-icons/fi';
import { useTranslation, Trans } from 'react-i18next';

interface OnboardingTourProps {
  isOpen: boolean;
  onClose: () => void;
}

const TourStep = ({ icon, title, children }: { icon: React.ReactNode, title: string, children: React.ReactNode }) => (
  <div className="text-center">
    <div className="mx-auto mb-4 w-16 h-16 flex items-center justify-center rounded-full bg-secondary shadow-neumorphic-convex">
      {icon}
    </div>
    <h3 className="text-xl font-bold mb-2 text-text-primary">{title}</h3>
    <div className="text-text-secondary space-y-2">
      {children}
    </div>
  </div>
);

export default function OnboardingTour({ isOpen, onClose }: OnboardingTourProps) {
  const { t } = useTranslation(['modals', 'common']);
  const [currentStep, setCurrentStep] = useState(0);
  const { setUser } = useAuthStore(useShallow(s => ({ setUser: s.setUser })));

  const handleNext = () => setCurrentStep(prev => prev + 1);
  const handlePrev = () => setCurrentStep(prev => prev - 1);

  const handleFinish = async () => {
    try {
      await api('/api/users/me/complete-onboarding', { method: 'POST' });
      // Update user state locally to reflect completion
      const user = useAuthStore.getState().user;
      if (user) {
        setUser({ ...user, hasCompletedOnboarding: true });
      }
    } catch (error) {
      console.error("Failed to mark onboarding as complete", error);
    } finally {
      onClose();
    }
  };

  const steps = [
    {
      icon: <FiSmile size={32} className="text-accent" />,
      title: t('modals:tour.steps.welcome.title'),
      content: <p><Trans i18nKey="modals:tour.steps.welcome.content">You have entered a <strong>Zero-Knowledge</strong> zone. We don&apos;t know who you are, and we can&apos;t read your messages. Total anonymity.</Trans></p>
    },
    {
      icon: <FiKey size={32} className="text-accent" />,
      title: t('modals:tour.steps.phrase.title'),
      content: (
        <>
          <p><Trans i18nKey="modals:tour.steps.phrase.content_1">During registration, you generated a 24-word Recovery Phrase. This is the <strong>only</strong> way to restore your account if you forget your password.</Trans></p>
          <p className="font-bold">{t('modals:tour.steps.phrase.content_2')}</p>
        </>
      )
    },
    {
      icon: <FiShield size={32} className="text-accent" />,
      title: t('modals:tour.steps.sandbox.title'),
      content: <p><Trans i18nKey="modals:tour.steps.sandbox.content">To prevent spam without using phone numbers, new accounts start in <strong>Sandbox Mode</strong>. You can unlock unlimited messaging by verifying you are human (Biometric or Proof of Work) in Settings.</Trans></p>
    },
    {
      icon: <FiShield size={32} className="text-accent" />,
      title: t('modals:tour.steps.safety.title'),
      content: <p>{t('modals:tour.steps.safety.content')}</p>    },
    {
      icon: <FiCoffee size={32} className="text-accent" />,
      title: t('modals:tour.steps.community.title'),
      content: (
        <>
          <p><Trans i18nKey="modals:tour.steps.community.content_1">Nyx runs on <strong>free-tier infrastructure</strong>, so you might experience occasional delays or reconnection moments.</Trans></p>
          <p className="mt-2"><Trans i18nKey="modals:tour.steps.community.content_2">If you enjoy the app, you can help us upgrade to faster servers anytime! Just go to <strong>Settings</strong> and scroll to the bottom to support the project.</Trans></p>
          <p className="font-bold mt-2 text-accent">{t('modals:tour.steps.community.content_3')}</p>
        </>
      )
    }
  ];

  const currentStepData = steps[currentStep];

  return (
    <ModalBase isOpen={isOpen} onClose={handleFinish} title={t('modals:tour.title')}>
      <div className="flex flex-col items-center gap-4 min-h-[250px]">
        <div className="flex-1 flex items-center">
          {currentStepData && (
            <TourStep icon={currentStepData.icon} title={currentStepData.title}>
              {currentStepData.content}
            </TourStep>
          )}
        </div>
        <div className="w-full flex justify-between items-center pt-4 border-t border-border">
          <div>
            {currentStep > 0 && (
              <button onClick={handlePrev} className="px-4 py-2 text-sm rounded-lg font-semibold text-text-secondary bg-bg-surface shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all">
                {t('common:actions.previous')}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {Array(steps.length).fill(0).map((_, i) => (
              <div key={i} className={`w-2 h-2 rounded-full transition-colors ${i === currentStep ? 'bg-accent' : 'bg-border'}`} />
            ))}
          </div>
          <div>
            {currentStep < steps.length - 1 ? (
              <button onClick={handleNext} className="px-4 py-2 text-sm rounded-lg font-semibold text-white bg-accent shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all">
                {t('common:actions.next')}
              </button>
            ) : (
              <button onClick={handleFinish} className="px-4 py-2 text-sm rounded-lg font-semibold text-white bg-accent shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all">
                {t('common:actions.finish')}
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalBase>
  );
}
