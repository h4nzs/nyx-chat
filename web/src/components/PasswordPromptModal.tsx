
import { useState } from 'react';
import { useModalStore } from '@store/modal';
import { FiKey } from 'react-icons/fi';

export default function PasswordPromptModal() {
  const { isPasswordPromptOpen, onPasswordSubmit, hidePasswordPrompt } = useModalStore();
  const [password, setPassword] = useState('');

  if (!isPasswordPromptOpen) {
    return null;
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onPasswordSubmit(password);
    setPassword('');
    hidePasswordPrompt();
  };

  const handleCancel = () => {
    onPasswordSubmit(null);
    setPassword('');
    hidePasswordPrompt();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="card-neumorphic p-8 w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-6">
          <FiKey className="text-accent text-4xl mb-4" />
          <h2 className="text-xl font-bold text-text-primary">Password Required</h2>
          <p className="text-text-secondary mt-2 text-sm">To decrypt your keys and continue, please enter your login password.</p>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="password-prompt" className="sr-only">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full input-neumorphic mb-4"
              placeholder="Enter your password"
            />
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleCancel}
              className="w-full py-2 px-4 rounded-lg bg-bg-surface text-text-primary shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="w-full py-2 px-4 rounded-lg bg-accent text-white shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
            >
              Continue
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
