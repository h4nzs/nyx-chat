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
          <input
            aria-label="Name"
            className="w-full input-neumorphic"
            placeholder="Name"
            value={name}
            onChange={(e) => setE(e.target.value)}
            disabled={isLoading}
          />
          <input
            aria-label="Email"
            className="w-full input-neumorphic"
            placeholder="Email"
            value={email}
            onChange={(e) => setC(e.target.value)}
            disabled={isLoading}
          />
          <input
            aria-label="Username"
            className="w-full input-neumorphic"
            placeholder="Username"
            value={username}
            onChange={(e) => setD(e.target.value)}
            disabled={isLoading}
          />
        </>
      ) : (
        <input
          aria-label="Email or Username"
          className="w-full input-neumorphic"
          placeholder="Email or Username"
          value={emailOrUsername}
          onChange={(e) => setA(e.target.value)}
          disabled={isLoading}
        />
      )}

      <input
        aria-label="Password"
        minLength={8}
        className="w-full input-neumorphic"
        placeholder="Password"
        type="password"
        value={password}
        onChange={(e) => setB(e.target.value)}
        disabled={isLoading}
      />

      <button
        className="w-full p-3 rounded-lg font-semibold text-white bg-accent shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bg-surface focus:ring-accent disabled:opacity-70"
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