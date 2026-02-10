// Shared sanitization utilities for NYX

/**
 * Sanitizes text content to prevent XSS while preserving plain text
 * @param content - The content to sanitize
 * @returns Sanitized content string
 */
export function sanitizeText(content: any): string {
  if (content === null || content === undefined) return '';
  
  const str = typeof content === "string" ? content : String(content);
  
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
    .replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=["'][^"']*["']/gi, '');
}

/**
 * Alias for sanitizeText for backward compatibility
 */
export function sanitizeHtml(content: any): string {
  return sanitizeText(content);
}