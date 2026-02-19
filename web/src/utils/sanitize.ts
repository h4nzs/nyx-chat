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
  
  // Configure DOMPurify to strip ALL tags and attributes, returning only plain text
  return DOMPurify.sanitize(str, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

/**
 * Alias for sanitizeText for backward compatibility
 */
export function sanitizeHtml(content: unknown): string {
  return sanitizeText(content);
}