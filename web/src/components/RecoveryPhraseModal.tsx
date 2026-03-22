import { useState, useMemo } from 'react';
import { FiShield, FiEye, FiEyeOff, FiClipboard } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Trans } from 'react-i18next';

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
  const { t } = useTranslation(['modals', 'common']);
  const [step, setStep] = useState(1);
  const [showPhrase, setShowPhrase] = useState(false);
  const [userInput, setUserInput] = useState<string[]>([]);

  const words = useMemo(() => phrase.split(' '), [phrase]);
  const verificationWords = useMemo(() => shuffle([...words]), [words]);

  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(phrase);
      toast.success(t('modals:recovery.copy_success'));
    } catch (err) {
      toast.error(t('modals:recovery.copy_fail'));
    }
  };

  const handleWordClick = (word: string) => {
    if (userInput.includes(word) || userInput.length >= phrase.split(' ').length) return;
    setUserInput(prev => [...prev, word]);
  };

  const handleUndo = () => {
    setUserInput(prev => prev.slice(0, -1));
  };

  const handleVerify = () => {
    if (userInput.join(' ') === phrase) {
      toast.success(t('modals:recovery.verify_success'));
      onClose();
    } else {
      toast.error(t('modals:recovery.verify_fail'));
      setUserInput([]);
    }
  };

  const renderStep1 = () => (
    <>
      <div className="flex flex-col items-center text-center mb-8">
        <div className="p-4 rounded-full bg-bg-main shadow-neumorphic-convex text-accent mb-4">
           <FiShield size={32} />
        </div>
        <h2 className="text-xl font-black uppercase tracking-wide text-text-primary">{t('modals:recovery.title')}</h2>
        <p className="text-xs text-text-secondary mt-2 leading-relaxed font-mono whitespace-pre-line">
          {t('modals:recovery.subtitle')}
        </p>
      </div>
      
      <div className="bg-bg-main p-4 rounded-xl shadow-neumorphic-concave border-l-4 border-red-500 mb-8">
        <div className="flex items-center gap-2 mb-1 text-red-500 font-bold uppercase text-[10px] tracking-widest">
           <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
           {t('modals:recovery.warning_title')}
        </div>
        <p className="text-xs text-text-secondary">
          {t('modals:recovery.warning_desc')}
        </p>
      </div>
      
      <button
        onClick={() => setStep(2)}
        className="
          w-full py-3 rounded-xl 
          bg-bg-surface text-text-primary font-bold uppercase tracking-wider text-xs
          shadow-neumorphic-convex active:shadow-neumorphic-pressed
          hover:text-accent transition-all
        "
      >
        {t('modals:recovery.button_acknowledge')}
      </button>
    </>
  );

  const renderStep2 = () => (
    <>
      <h2 className="text-xl font-black uppercase tracking-wide text-text-primary text-center mb-2">{t('modals:recovery.step2_title')}</h2>
      <p className="text-xs text-text-secondary text-center mb-6 font-mono">{t('modals:recovery.step2_desc')}</p>
      
      <div className="relative bg-bg-main p-6 rounded-2xl shadow-neumorphic-concave mb-6 border border-white/5">
        <div className={`grid grid-cols-3 gap-3 ${!showPhrase ? 'blur-sm opacity-50' : ''} transition-all duration-500`}>
          {words.map((word, index) => (
            <div key={index} className="flex items-center gap-2 p-2 rounded bg-black/10 dark:bg-white/5 border border-white/10">
               <span className="text-[10px] text-text-secondary font-mono w-4">{index + 1}.</span>
               <span className="text-sm font-bold text-text-primary tracking-wide">{word}</span>
            </div>
          ))}
        </div>
        
        {!showPhrase && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <button 
              onClick={() => setShowPhrase(true)}
              className="
                flex items-center gap-2 px-6 py-3 rounded-full 
                bg-bg-surface text-text-primary font-bold text-sm
                shadow-neumorphic-convex active:shadow-neumorphic-pressed
                transition-all
              "
            >
              <FiEye /> {t('modals:recovery.button_reveal')}
            </button>
          </div>
        )}
        
        {showPhrase && (
           <div className="absolute top-2 right-2 flex gap-2">
             <button onClick={() => setShowPhrase(false)} aria-label="Toggle phrase visibility" className="p-2 rounded-full bg-bg-surface shadow-neumorphic-convex text-text-secondary hover:text-text-primary"><FiEyeOff size={14} /></button>
             <button onClick={handleCopyToClipboard} aria-label="Copy recovery phrase" className="p-2 rounded-full bg-bg-surface shadow-neumorphic-convex text-text-secondary hover:text-text-primary"><FiClipboard size={14} /></button>
           </div>
        )}
      </div>
      
      <button
        onClick={() => setStep(3)}
        className="w-full py-3 rounded-xl bg-accent text-white font-bold uppercase tracking-wider shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
      >
        {t('modals:recovery.button_recorded')}
      </button>
    </>
  );

  const renderStep3 = () => (
    <>
      <h2 className="text-xl font-black uppercase tracking-wide text-text-primary text-center mb-2">{t('modals:recovery.verify_title')}</h2>
      <p className="text-xs text-text-secondary text-center mb-6 font-mono">{t('modals:recovery.verify_desc')}</p>
      
      <div className="
        bg-bg-main p-4 rounded-xl shadow-neumorphic-concave 
        min-h-[100px] mb-6 font-mono text-sm text-center flex flex-wrap gap-2 justify-center items-center
        border border-white/5
      ">
        {userInput.length === 0 && <span className="text-text-secondary/40">{t('modals:recovery.select_words')}</span>}
        {userInput.map((word, i) => (
           <span key={i} className="px-2 py-1 rounded bg-accent/20 text-accent border border-accent/30">{word}</span>
        ))}
      </div>
      
      <div className="flex flex-wrap gap-2 justify-center mb-8">
        {verificationWords.map((word, index) => (
          <button
            key={index}
            onClick={() => handleWordClick(word)}
            disabled={userInput.includes(word) || userInput.length >= phrase.split(' ').length}
            className="
              px-3 py-2 rounded-lg 
              bg-bg-surface text-text-primary text-xs font-bold
              shadow-neumorphic-convex active:shadow-neumorphic-pressed 
              hover:-translate-y-0.5 transition-all
            "
          >
            {word}
          </button>
        ))}
      </div>
      
      <div className="flex gap-4">
        <button
          onClick={handleUndo}
          disabled={userInput.length === 0}
          className="flex-1 py-3 rounded-xl bg-bg-surface text-text-secondary font-bold uppercase text-xs shadow-neumorphic-convex active:shadow-neumorphic-pressed disabled:opacity-50 transition-all"
        >
          {t('modals:recovery.undo')}
        </button>
        <button
          onClick={handleVerify}
          disabled={userInput.length !== words.length}
          className="flex-1 py-3 rounded-xl bg-accent text-white font-bold uppercase text-xs shadow-neumorphic-convex active:shadow-neumorphic-pressed disabled:opacity-50 disabled:shadow-none transition-all"
        >
          {t('modals:recovery.confirm')}
        </button>
      </div>
    </>
  );

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-bg-surface p-8 rounded-3xl shadow-neumorphic-convex w-full max-w-md relative border border-white/10">
        <button 
          onClick={onClose} 
          className="absolute top-4 right-4 p-2 rounded-full text-text-secondary shadow-neumorphic-convex active:shadow-neumorphic-pressed hover:text-red-500 transition-all"
        >
          &times;
        </button>
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
      </div>
    </div>
  );
}
