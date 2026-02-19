import DOMPurify from 'dompurify';

// Shared sanitization utilities for NYX

/**
 * Sanitizes text content to prevent XSS while preserving plain text
 * @param content - The content to sanitize
 * @returns Sanitized content string
 */
export function sanitizeText(content: unknown): string {
  if (content === null || content === undefined) return '';
  
  const str = typeof content === "string" ? content : String(content);
  
  // Use DOMPurify to sanitize HTML content if needed, 
  // but for now, we will stick to the textContent approach if the goal is plain text.
  // However, the prompt implies replacing the regex blocklist with a safe approach.
  
  // If the intent is to render this as plain text (e.g. via textContent/innerText), 
  // we don't strictly need to strip HTML tags unless we want to remove them for display.
  // But if the previous behavior was to strip dangerous tags, DOMPurify is safer.
  
  // Let's use DOMPurify to strip dangerous tags but keep safe HTML if that was the intent,
  // OR strip ALL tags if the intent was plain text.
  // Based on the function name "sanitizeText", it implies returning safe text.
  
  // A safe approach for "sanitizeText" that might be used in HTML contexts
  // is to let DOMPurify handle it.
  
  return DOMPurify.sanitize(str);
}

/**
 * Alias for sanitizeText for backward compatibility
 */
export function sanitizeHtml(content: unknown): string {
  return sanitizeText(content);
}