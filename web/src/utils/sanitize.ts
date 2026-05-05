import DOMPurify from 'dompurify'

// Shared sanitization utilities for NYX

/**
 * Sanitizes text content to prevent XSS while preserving plain text
 * @param content - The content to sanitize
 * @returns Sanitized content string
 */
export function sanitizeText(content: unknown): string {
  if (content === null || content === undefined) return ''

  const str = typeof content === 'string' ? content : String(content)

  // Configure DOMPurify to strip ALL tags and attributes, returning only plain text
  return DOMPurify.sanitize(str, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
}

/**
 * Alias for sanitizeText for backward compatibility
 */
export function sanitizeHtml(content: unknown): string {
  return sanitizeText(content)
}

/**
 * Sanitizes error objects or messages before logging them to the console to prevent leakage
 * of private keys, plaintext payloads, or base64 ciphertext.
 * @param error - The error to sanitize
 * @returns A safe error string
 */
export function sanitizeErrorLog(error: unknown): string {
  if (!error) return 'Unknown Error'

  let errorMsg =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)

  // 1. Scrub JSON-like objects (e.g. {"ciphertext": "..."})
  errorMsg = errorMsg.replace(/\{[\s\S]*?\}/g, '[REDACTED_OBJECT]')

  // 2. Scrub long contiguous strings that look like base64 or hex keys (length > 32)
  errorMsg = errorMsg.replace(
    /\b[a-zA-Z0-9+/=_-]{32,}\b/g,
    '[REDACTED_KEY_OR_B64]'
  )

  // 3. Limit length to prevent massive payload dumping
  if (errorMsg.length > 200) {
    errorMsg = errorMsg.substring(0, 200) + '... [TRUNCATED]'
  }

  return errorMsg
}
