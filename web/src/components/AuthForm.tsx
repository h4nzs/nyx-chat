import { useState } from 'react'
import Alert from './Alert'
import { Spinner } from './Spinner';
import { handleApiError } from '@lib/api';
import { useTranslation } from 'react-i18next';

// ✅ FIX 1: Tambahkan `disabled?: boolean` ke definisi props
interface AuthFormProps {
  onSubmit: (v: { a: string; b?: string; c?: string; d?: string; name?: string }) => Promise<void>;
  button: string;
  hideEmail?: boolean;
  isRegister?: boolean;
  disabled?: boolean;
}

export default function AuthForm({ onSubmit, button, hideEmail = false, isRegister = false, disabled = false }: AuthFormProps) {
  const { t } = useTranslation(['auth', 'common']);
  const [emailOrUsername, setA] = useState('')
  const [password, setB] = useState('')
  const [email, setC] = useState('')
  const [username, setD] = useState('')
  const [name, setE] = useState('')
  const [err, setErr] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [isFocused, setIsFocused] = useState({
    emailOrUsername: false,
    password: false,
    email: false,
    username: false,
    name: false
  })

  // Function to validate email format (Only relevant if email is used)
  const isValidEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(email)
  }

  const emailIsValid = isValidEmail(email)

  // Determine button text from props or translation
  const getButtonText = () => {
      if (button === 'Login') return t('auth:buttons.login');
      if (button === 'Register') return t('auth:buttons.register');
      return button; // Akan merender 'Checking Security...' jika dikirim dari luar
  };
  
  const buttonText = getButtonText();
  const loadingText = t('common:actions.loading');

  // ✅ FIX 2: Gabungkan status loading internal dengan disabled eksternal (Turnstile)
  const isButtonDisabled = isLoading || disabled;

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        if (isButtonDisabled) return; // Mencegah submit paksa jika masih disabled
        
        setErr('')
        setIsLoading(true)
        try {
          await onSubmit({ a: emailOrUsername, b: password, c: email, d: username, name })
        }
        catch (ex: unknown) {
          setErr(handleApiError(ex));
        } finally {
          setIsLoading(false)
        }
      }}
    >
      {err ? <Alert message={err} /> : null}

      {isRegister ? (
        <>
          <div className="relative">
            <input
              aria-label={t('auth:fields.display_name')}
              className={`w-full px-4 py-3 bg-bg-main text-text-primary rounded-lg focus:outline-none focus:ring-2 focus:ring-accent transition-all duration-300 ${
                isFocused.name 
                  ? 'shadow-neu-pressed dark:shadow-neu-pressed-dark' 
                  : 'shadow-neu-flat dark:shadow-neu-flat-dark'
              }`}
              placeholder={t('auth:fields.display_name')}
              value={name}
              onChange={(e) => setE(e.target.value)}
              disabled={isLoading}
              onFocus={() => setIsFocused({...isFocused, name: true})}
              onBlur={() => setIsFocused({...isFocused, name: false})}
            />
            <div className="absolute right-3 top-1/2 transform -translate-y-1/2 w-2 h-2 rounded-full bg-transparent transition-colors duration-300"></div>
          </div>

          {!hideEmail && (
            <div className="relative">
              <input
                aria-label={t('auth:fields.email')}
                className={`w-full px-4 py-3 bg-bg-main text-text-primary rounded-lg focus:outline-none focus:ring-2 focus:ring-accent transition-all duration-300 ${
                  isFocused.email 
                    ? 'shadow-neu-pressed dark:shadow-neu-pressed-dark' 
                    : 'shadow-neu-flat dark:shadow-neu-flat-dark'
                } ${
                  emailIsValid ? 'border border-green-500' : 'border border-transparent'
                }`}
                placeholder={t('auth:fields.email')}
                value={email}
                onChange={(e) => setC(e.target.value)}
                disabled={isLoading}
                onFocus={() => setIsFocused({...isFocused, email: true})}
                onBlur={() => setIsFocused({...isFocused, email: false})}
              />
              <div className={`absolute right-3 top-1/2 transform -translate-y-1/2 w-2 h-2 rounded-full transition-colors duration-300 ${
                emailIsValid ? 'bg-green-500' : 'bg-transparent'
              }`}></div>
            </div>
          )}

          <div className="relative">
            <input
              aria-label={t('auth:fields.username_id')}
              className={`w-full px-4 py-3 bg-bg-main text-text-primary rounded-lg focus:outline-none focus:ring-2 focus:ring-accent transition-all duration-300 ${
                isFocused.username 
                  ? 'shadow-neu-pressed dark:shadow-neu-pressed-dark' 
                  : 'shadow-neu-flat dark:shadow-neu-flat-dark'
              }`}
              placeholder={t('auth:fields.username_id')}
              value={username}
              onChange={(e) => setD(e.target.value)}
              disabled={isLoading}
              onFocus={() => setIsFocused({...isFocused, username: true})}
              onBlur={() => setIsFocused({...isFocused, username: false})}
            />
            <div className="absolute right-3 top-1/2 transform -translate-y-1/2 w-2 h-2 rounded-full bg-transparent transition-colors duration-300"></div>
          </div>
        </>
      ) : (
        <div className="relative">
          <input
            aria-label={t('auth:fields.username')}
            className={`w-full px-4 py-3 bg-bg-main text-text-primary rounded-lg focus:outline-none focus:ring-2 focus:ring-accent transition-all duration-300 ${
              isFocused.emailOrUsername 
                ? 'shadow-neu-pressed dark:shadow-neu-pressed-dark' 
                : 'shadow-neu-flat dark:shadow-neu-flat-dark'
            }`}
            placeholder={t('auth:fields.username')}
            value={emailOrUsername}
            onChange={(e) => setA(e.target.value)}
            disabled={isLoading}
            onFocus={() => setIsFocused({...isFocused, emailOrUsername: true})}
            onBlur={() => setIsFocused({...isFocused, emailOrUsername: false})}
          />
        </div>
      )}

      <div className="relative">
        <input
          aria-label={t('auth:fields.password')}
          minLength={8}
          className={`w-full px-4 py-3 bg-bg-main text-text-primary rounded-lg focus:outline-none focus:ring-2 focus:ring-accent transition-all duration-300 ${
            isFocused.password 
              ? 'shadow-neu-pressed dark:shadow-neu-pressed-dark' 
              : 'shadow-neu-flat dark:shadow-neu-flat-dark'
          }`}
          placeholder={t('auth:fields.password')}
          type="password"
          value={password}
          onChange={(e) => setB(e.target.value)}
          disabled={isLoading}
          onFocus={() => setIsFocused({...isFocused, password: true})}
          onBlur={() => setIsFocused({...isFocused, password: false})}
        />
        <div className="absolute right-3 top-1/2 transform -translate-y-1/2 w-2 h-2 rounded-full bg-transparent transition-colors duration-300"></div>
      </div>

      {/* ✅ FIX 3: Tambahkan type="submit" dan terapkan state isButtonDisabled */}
      <button
        type="submit"
        className={`w-full py-3 rounded-lg font-bold uppercase tracking-wider text-white transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bg-surface focus:ring-accent bg-accent shadow-neu-flat dark:shadow-neu-flat-dark hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark ${
          isButtonDisabled ? 'opacity-50 cursor-not-allowed' : ''
        }`}
        aria-label={buttonText}
        disabled={isButtonDisabled}
      >
        {isLoading ? (
          <div className="flex items-center justify-center">
            <Spinner size="sm" className="mr-2" />
            {loadingText}
          </div>
        ) : buttonText}
      </button>
    </form>
  )
}
