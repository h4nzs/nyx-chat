import { useEffect } from 'react';

/**
 * A custom hook that listens for a specific key combination globally
 * and calls the provided callback function.
 * @param keyCombo An array of keys that make up the combination (e.g., ['Control', 'k']). Case-insensitive.
 * @param callback The function to call when the key combination is pressed.
 */
export function useGlobalShortcut(keyCombo: string[], callback: () => void) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const requiredKeys = keyCombo.map(k => k.toLowerCase());
      const lastKey = requiredKeys.pop();

      if (!lastKey) {
        return;
      }

      if (e.key.toLowerCase() !== lastKey) {
        return;
      }

      // Check if ONLY the required modifiers are pressed
      const requiredCtrl = requiredKeys.includes('control');
      const requiredAlt = requiredKeys.includes('alt');
      const requiredShift = requiredKeys.includes('shift');
      const requiredMeta = requiredKeys.includes('meta');

      if (
        e.ctrlKey === requiredCtrl &&
        e.altKey === requiredAlt &&
        e.shiftKey === requiredShift &&
        e.metaKey === requiredMeta
      ) {
        e.preventDefault();
        callback();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [keyCombo, callback]);
}
