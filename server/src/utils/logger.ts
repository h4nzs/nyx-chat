// Helper to sanitize potentially user-controlled values before logging them to prevent Log Injection
export function sanitizeForLog (value: unknown): string {
  if (value === null || value === undefined) return '';
  // Karakter kontrol memang target sanitasi (log injection: CR/LF + escape ANSI
  // 0x7F–0x9F); ini penggunaan yang disengaja, bukan regex yang keliru.
  // oxlint-disable-next-line no-control-regex
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\r\n]/g, '').replace(/[\x00-\x1F\x7F-\x9F]/g, '');
}
