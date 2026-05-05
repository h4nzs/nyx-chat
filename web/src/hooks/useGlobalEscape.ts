import { useEffect } from 'react'

/**
 * A custom hook that listens for the 'Escape' key press globally
 * and calls the provided callback function.
 * @param callback The function to call when the Escape key is pressed.
 */
export function useGlobalEscape(callback: () => void) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        callback()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [callback]) // Re-run the effect if the callback changes
}
