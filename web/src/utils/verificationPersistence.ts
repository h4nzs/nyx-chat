// Helper functions to manage email verification state persistence

const VERIFICATION_STATE_KEY = 'pending_email_verification';

export interface VerificationState {
  userId: string;
  email: string;
  timestamp: number; // Unix timestamp when state was saved
}

/**
 * Save verification state to localStorage
 */
export function saveVerificationState(state: VerificationState): void {
  try {
    localStorage.setItem(VERIFICATION_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('Failed to save verification state:', error);
  }
}

/**
 * Get verification state from localStorage
 */
export function getVerificationState(): VerificationState | null {
  try {
    const stored = localStorage.getItem(VERIFICATION_STATE_KEY);
    if (!stored) return null;
    
    const parsed = JSON.parse(stored);
    // Check if the state is still valid (less than 30 minutes old)
    const age = Date.now() - parsed.timestamp;
    const THIRTY_MINUTES = 30 * 60 * 1000;
    
    if (age > THIRTY_MINUTES) {
      clearVerificationState();
      return null;
    }
    
    return parsed;
  } catch (error) {
    console.error('Failed to parse verification state:', error);
    clearVerificationState();
    return null;
  }
}

/**
 * Clear verification state from localStorage
 */
export function clearVerificationState(): void {
  try {
    localStorage.removeItem(VERIFICATION_STATE_KEY);
  } catch (error) {
    console.error('Failed to clear verification state:', error);
  }
}