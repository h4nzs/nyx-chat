import { useState } from 'react';
import ModalBase from './ui/ModalBase';
import { useAuthStore } from '@store/auth';
import { api } from '@lib/api';
import { FiKey, FiShield, FiSmile, FiCoffee } from 'react-icons/fi'; // Tambah FiCoffee

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
  const [currentStep, setCurrentStep] = useState(0);
  const { setUser } = useAuthStore();

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
      title: "Welcome to Nyx!",
      content: <p>Let's quickly go over a few key security features to keep your conversations private.</p>
    },
    {
      icon: <FiKey size={32} className="text-accent" />,
      title: "Your Recovery Phrase",
      content: (
        <>
          <p>During registration, you were given a unique 24-word Recovery Phrase. This is the **only** way to restore your account if you forget your password.</p>
          <p className="font-bold">We do not store it and cannot recover it for you. Keep it safe and offline!</p>
        </>
      )
    },
    {
      icon: <FiShield size={32} className="text-accent" />,
      title: "Safety Numbers",
      content: <p>Each conversation has a unique "Safety Number". You can compare this number with your contact out-of-band (e.g., in person or on a video call) to verify your end-to-end encryption connection and ensure you're talking to the right person.</p>
    },
    {
      // --- SLIDE BARU: Server Status & Support ---
      icon: <FiCoffee size={32} className="text-accent" />,
      title: "Community & Performance",
      content: (
        <>
          <p>Nyx runs on <strong>free-tier infrastructure</strong>, so you might experience occasional delays or reconnection moments.</p>
          <p className="mt-2">If you enjoy the app, you can help us upgrade to faster servers anytime! Just go to <strong>Settings</strong> and scroll to the bottom to support the project.</p>
          <p className="font-bold mt-2 text-accent">Enjoy your secure chats!</p>
        </>
      )
    }
  ];

  const currentStepData = steps[currentStep];

  return (
    <ModalBase isOpen={isOpen} onClose={handleFinish} title="Quick Tour">
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
                Previous
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
                Next
              </button>
            ) : (
              <button onClick={handleFinish} className="px-4 py-2 text-sm rounded-lg font-semibold text-white bg-accent shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all">
                Finish
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalBase>
  );
}