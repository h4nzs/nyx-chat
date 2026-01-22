
import { useState, useMemo } from 'react';
import { FiShield, FiEye, FiEyeOff, FiClipboard } from 'react-icons/fi';
import toast from 'react-hot-toast';

interface RecoveryPhraseModalProps {
  phrase: string;
  onClose: () => void;
}

// Helper to shuffle an array
const shuffle = <T,>(array: T[]): T[] => {
  let currentIndex = array.length, randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
};

export default function RecoveryPhraseModal({ phrase, onClose }: RecoveryPhraseModalProps) {
  const [step, setStep] = useState(1);
  const [showPhrase, setShowPhrase] = useState(false);
  const [userInput, setUserInput] = useState<string[]>([]);

  const words = useMemo(() => phrase.split(' '), [phrase]);
  const verificationWords = useMemo(() => shuffle([...words]), [words]);

  const handleCopyToClipboard = () => {
    navigator.clipboard.writeText(phrase);
    toast.success('Recovery phrase copied to clipboard!');
  };

  const handleWordClick = (word: string) => {
    setUserInput(prev => [...prev, word]);
  };

  const handleUndo = () => {
    setUserInput(prev => prev.slice(0, -1));
  };

  const handleVerify = () => {
    if (userInput.join(' ') === phrase) {
      toast.success('Verification successful! Your backup is confirmed.');
      onClose();
    } else {
      toast.error('Verification failed. Please try again.');
      setUserInput([]);
    }
  };

  const renderStep1 = () => (
    <>
      <div className="flex flex-col items-center text-center mb-6">
        <FiShield className="text-accent text-5xl mb-4" />
        <h2 className="text-2xl font-bold text-text-primary">Your Recovery Phrase</h2>
        <p className="text-text-secondary mt-2">
          This is the **only** way to recover your account if you lose access. Write it down and store it in a secure, offline location.
        </p>
      </div>
      <div className="bg-destructive/10 text-destructive p-4 rounded-lg text-sm mb-6">
        <p className="font-bold">NEVER share this phrase with anyone. Anyone with this phrase can access all your messages.</p>
      </div>
      <button
        onClick={() => setStep(2)}
        className="w-full btn btn-primary"
      >
        I Understand, Show My Phrase
      </button>
    </>
  );

  const renderStep2 = () => (
    <>
      <h2 className="text-2xl font-bold text-text-primary text-center mb-4">Save Your Phrase</h2>
      <p className="text-text-secondary text-center mb-6">Write down these {words.length} words in order. Keep them safe.</p>
      <div className="relative bg-background p-4 rounded-lg border border-border mb-4">
        <div className={`grid grid-cols-3 gap-x-6 gap-y-4 text-lg ${!showPhrase ? 'blur-md' : ''}`}>
          {words.map((word, index) => (
            <span key={index} className="text-text-primary font-mono">{index + 1}. {word}</span>
          ))}
        </div>
        {!showPhrase && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-lg">
            <p className="text-white font-semibold">Click the eye to reveal</p>
          </div>
        )}
        <div className="absolute top-3 right-3 flex gap-2">
          <button onClick={() => setShowPhrase(!showPhrase)} className="text-text-secondary hover:text-text-primary">
            {showPhrase ? <FiEyeOff /> : <FiEye />}
          </button>
          <button onClick={handleCopyToClipboard} className="text-text-secondary hover:text-text-primary">
            <FiClipboard />
          </button>
        </div>
      </div>
      <button
        onClick={() => setStep(3)}
        className="w-full btn btn-primary"
      >
        I've Saved It, Now Verify
      </button>
    </>
  );

  const renderStep3 = () => (
    <>
      <h2 className="text-2xl font-bold text-text-primary text-center mb-4">Verify Your Phrase</h2>
      <p className="text-text-secondary text-center mb-6">Tap the words in the correct order to confirm your backup.</p>
      <div className="bg-background p-4 rounded-lg border border-border min-h-[100px] mb-4 font-mono text-lg text-center">
        {userInput.join(' ') || <span className="text-text-secondary">Your selected words will appear here...</span>}
      </div>
      <div className="flex flex-wrap gap-3 justify-center mb-6">
        {verificationWords.map((word, index) => (
          <button
            key={index}
            onClick={() => handleWordClick(word)}
            className="px-4 py-2 rounded-lg bg-bg-surface text-text-primary shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
          >
            {word}
          </button>
        ))}
      </div>
      <div className="flex gap-4">
        <button
          onClick={handleUndo}
          disabled={userInput.length === 0}
          className="w-full py-3 px-4 rounded-lg bg-bg-surface text-text-primary shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all disabled:opacity-50"
        >
          Undo
        </button>
        <button
          onClick={handleVerify}
          disabled={userInput.length !== words.length}
          className="w-full btn btn-primary disabled:opacity-50"
        >
          Verify
        </button>
      </div>
    </>
  );

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="card-neumorphic p-8 w-full max-w-md relative">
        <button onClick={onClose} className="absolute top-4 right-4 touch-target p-1.5 rounded-full text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all">&times;</button>
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
      </div>
    </div>
  );
}
