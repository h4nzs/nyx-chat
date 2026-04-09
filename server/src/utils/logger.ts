// Helper to sanitize potentially user-controlled values before logging them to prevent Log Injection
export function sanitizeForLog (value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\r\n]/g, '').replace(/[\x00-\x1F\x7F-\x9F]/g, '');
}
