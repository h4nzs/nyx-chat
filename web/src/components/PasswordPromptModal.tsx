
import { useState, useEffect } from 'react';
import { useModalStore } from '@store/modal';
import { verifyDecoyPin } from '@lib/biometricUnlock';
import { useKeychainStore } from '@store/keychain';

export default function PasswordPromptModal() {
  const { isPasswordPromptOpen, onPasswordSubmit, hidePasswordPrompt } = useModalStore();
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCancel = () => {
    onPasswordSubmit(null);
    setPassword('');
    hidePasswordPrompt();
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isPasswordPromptOpen) {
        handleCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPasswordPromptOpen]);

  if (!isPasswordPromptOpen) {
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      // 1. Check if it's the Decoy PIN
      const isDecoy = await verifyDecoyPin(password);
      
      if (isDecoy) {
          // --- DECOY VAULT TRIGGERED ---
          sessionStorage.setItem('nyx_decoy_mode', 'true');
          onPasswordSubmit({ mode: 'decoy' }); // Use object instead of dummy string
          setPassword('');
          hidePasswordPrompt();
          return;
      }

      // 2. Normal Unlock Flow
      sessionStorage.removeItem('nyx_decoy_mode');
      onPasswordSubmit({ mode: 'normal', password });
      setPassword('');
      hidePasswordPrompt();
    } catch (e) {
      setError('An error occurred');
    } finally {
      setIsLoading(false);
      setPassword('');
    }
  };

  return (
    <div 
      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleCancel}
    >
      <div 
        className="bg-[#1f2937] border-2 border-gray-700 rounded-lg p-8 w-full max-w-md mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-16 h-16 rounded-full bg-gray-800 border-2 border-orange-500 flex items-center justify-center mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-orange-500" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">ACCESS CONTROL PAD</h2>
          <p className="text-gray-400 text-sm">Enter your credentials to unlock secure vault</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="relative">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[#111827] border-2 border-gray-700 rounded-lg py-4 px-4 pr-12 text-white focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/30 transition-all duration-300"
              placeholder="Enter access code"
            />
            <div className="absolute right-4 top-1/2 transform -translate-y-1/2">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button
              type="button"
              onClick={handleCancel}
              className="py-3 px-4 rounded-lg bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700 transition-all duration-300"
            >
              ABORT
            </button>
            <button
              type="submit"
              className="py-3 px-4 rounded-lg bg-orange-600 text-white hover:bg-orange-700 shadow-[0_0_15px_rgba(249,115,22,0.4)] transition-all duration-300"
            >
              UNLOCK
            </button>
          </div>
        </form>

        <div className="mt-6 pt-4 border-t border-gray-800">
          <div className="flex justify-between text-xs text-gray-500">
            <span>Vault ID: SEC-7A9F</span>
            <span>Status: LOCKED</span>
          </div>
        </div>
      </div>
    </div>
  );
}
