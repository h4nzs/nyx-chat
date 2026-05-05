// A simple utility to manage conversation verification statuses in localStorage.

const VERIFIED_PREFIX = 'verified_conversation_'

/**
 * Marks a conversation as verified.
 * @param conversationId The ID of the conversation to verify.
 * @param peerPublicKey The public key of the peer to store for future checks.
 */
export function markAsVerified(
  conversationId: string,
  peerPublicKey: string
): void {
  try {
    localStorage.setItem(`${VERIFIED_PREFIX}${conversationId}`, peerPublicKey)
  } catch (e) {
    console.error('Failed to write to localStorage', e)
  }
}

/**
 * Checks if a conversation has been verified against a specific public key.
 * @param conversationId The ID of the conversation to check.
 * @param currentPeerPublicKey The peer's current public key from the server.
 * @returns True if the stored public key matches the current one, false otherwise.
 */
export function isVerified(
  conversationId: string,
  currentPeerPublicKey: string
): boolean {
  try {
    const storedKey = localStorage.getItem(
      `${VERIFIED_PREFIX}${conversationId}`
    )
    return storedKey !== null && storedKey === currentPeerPublicKey
  } catch (e) {
    console.error('Failed to read from localStorage', e)
    return false
  }
}

/**
 * Removes the verification status for a conversation.
 * @param conversationId The ID of the conversation to un-verify.
 */
export function unmarkAsVerified(conversationId: string): void {
  try {
    localStorage.removeItem(`${VERIFIED_PREFIX}${conversationId}`)
  } catch (e) {
    console.error('Failed to remove from localStorage', e)
  }
}
