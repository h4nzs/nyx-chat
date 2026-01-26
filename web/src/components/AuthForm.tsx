import { useState } from 'react'
import Alert from './Alert'
import { Spinner } from './Spinner';
import { handleApiError } from '@lib/api';

export default function AuthForm({ onSubmit, button }: { onSubmit: (v: { a: string; b?: string; c?: string; d?: string; name?: string }) => Promise<void>; button: string }) {
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

  // Function to validate email format
  const isValidEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(email)
  }

  // Determine if email is valid for green glow effect
  const emailIsValid = isValidEmail(email)
  const emailOrUsernameIsValid = isValidEmail(emailOrUsername)

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
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

      {button === 'Sign Up' ? (
        <>
          <div className="relative">
            <input
              aria-label="Name"
              className={`w-full px-4 py-3 bg-bg-main rounded-lg focus:outline-none focus:ring-2 focus:ring-accent transition-all duration-300 ${
                isFocused.name 
                  ? 'shadow-[inset_3px_3px_6px_rgba(0,0,0,0.3),inset_-3px_-3px_6px_rgba(255,255,255,0.1)]' 
                  : 'shadow-[6px_6px_12px_rgba(0,0,0,0.2),-6px_-6px_12px_rgba(255,255,255,0.1)]'
              }`}
              placeholder="Name"
              value={name}
              onChange={(e) => setE(e.target.value)}
              disabled={isLoading}
              onFocus={() => setIsFocused({...isFocused, name: true})}
              onBlur={() => setIsFocused({...isFocused, name: false})}
            />
            <div className="absolute right-3 top-1/2 transform -translate-y-1/2 w-2 h-2 rounded-full bg-transparent transition-colors duration-300"></div>
          </div>

          <div className="relative">
            <input
              aria-label="Email"
              className={`w-full px-4 py-3 bg-bg-main rounded-lg focus:outline-none focus:ring-2 focus:ring-accent transition-all duration-300 ${
                isFocused.email 
                  ? 'shadow-[inset_3px_3px_6px_rgba(0,0,0,0.3),inset_-3px_-3px_6px_rgba(255,255,255,0.1)]' 
                  : 'shadow-[6px_6px_12px_rgba(0,0,0,0.2),-6px_-6px_12px_rgba(255,255,255,0.1)]'
              } ${
                emailIsValid ? 'border border-green-500' : ''
              }`}
              placeholder="Email"
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

          <div className="relative">
            <input
              aria-label="Username"
              className={`w-full px-4 py-3 bg-bg-main rounded-lg focus:outline-none focus:ring-2 focus:ring-accent transition-all duration-300 ${
                isFocused.username 
                  ? 'shadow-[inset_3px_3px_6px_rgba(0,0,0,0.3),inset_-3px_-3px_6px_rgba(255,255,255,0.1)]' 
                  : 'shadow-[6px_6px_12px_rgba(0,0,0,0.2),-6px_-6px_12px_rgba(255,255,255,0.1)]'
              }`}
              placeholder="Username"
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
            aria-label="Email or Username"
            className={`w-full px-4 py-3 bg-bg-main rounded-lg focus:outline-none focus:ring-2 focus:ring-accent transition-all duration-300 ${
              isFocused.emailOrUsername 
                ? 'shadow-[inset_3px_3px_6px_rgba(0,0,0,0.3),inset_-3px_-3px_6px_rgba(255,255,255,0.1)]' 
                : 'shadow-[6px_6px_12px_rgba(0,0,0,0.2),-6px_-6px_12px_rgba(255,255,255,0.1)]'
            } ${
              emailOrUsernameIsValid ? 'border border-green-500' : ''
            }`}
            placeholder="Email or Username"
            value={emailOrUsername}
            onChange={(e) => setA(e.target.value)}
            disabled={isLoading}
            onFocus={() => setIsFocused({...isFocused, emailOrUsername: true})}
            onBlur={() => setIsFocused({...isFocused, emailOrUsername: false})}
          />
          <div className={`absolute right-3 top-1/2 transform -translate-y-1/2 w-2 h-2 rounded-full transition-colors duration-300 ${
            emailOrUsernameIsValid ? 'bg-green-500' : 'bg-transparent'
          }`}></div>
        </div>
      )}

      <div className="relative">
        <input
          aria-label="Password"
          minLength={8}
          className={`w-full px-4 py-3 bg-bg-main rounded-lg focus:outline-none focus:ring-2 focus:ring-accent transition-all duration-300 ${
            isFocused.password 
              ? 'shadow-[inset_3px_3px_6px_rgba(0,0,0,0.3),inset_-3px_-3px_6px_rgba(255,255,255,0.1)]' 
              : 'shadow-[6px_6px_12px_rgba(0,0,0,0.2),-6px_-6px_12px_rgba(255,255,255,0.1)]'
          }`}
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setB(e.target.value)}
          disabled={isLoading}
          onFocus={() => setIsFocused({...isFocused, password: true})}
          onBlur={() => setIsFocused({...isFocused, password: false})}
        />
        <div className="absolute right-3 top-1/2 transform -translate-y-1/2 w-2 h-2 rounded-full bg-transparent transition-colors duration-300"></div>
      </div>

      <button
        className={`w-full py-3 rounded-lg font-semibold text-white transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bg-surface focus:ring-accent disabled:opacity-70 ${
          button === 'Login' 
            ? 'bg-gradient-to-r from-orange-500 to-orange-600 shadow-[5px_5px_15px_rgba(255,107,53,0.4),-5px_-5px_15px_rgba(255,165,110,0.2)] hover:shadow-[3px_3px_10px_rgba(255,107,53,0.6),-3px_-3px_10px_rgba(255,165,110,0.3)] active:shadow-[inset_3px_3px_8px_rgba(139,69,19,0.6)]' 
            : 'bg-gradient-to-r from-teal-500 to-teal-600 shadow-[5px_5px_15px_rgba(0,150,150,0.4),-5px_-5px_15px_rgba(100,200,200,0.2)] hover:shadow-[3px_3px_10px_rgba(0,150,150,0.6),-3px_-3px_10px_rgba(100,200,200,0.3)] active:shadow-[inset_3px_3px_8px_rgba(0,100,100,0.6)]'
        }`}
        aria-label={button}
        disabled={isLoading}
      >
        {isLoading ? (
          <div className="flex items-center justify-center">
            <Spinner size="sm" className="mr-2" />
            {button}...
          </div>
        ) : button}
      </button>
    </form>
  )
}