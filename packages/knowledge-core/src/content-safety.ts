const SECRET_PATTERNS = [/-----BEGIN [A-Z ]+ PRIVATE KEY-----/i, /(?:api[_-]?(?:key|token)|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{12,}/i, /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/];
const PII_PATTERNS = [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi];
export interface SafeText { text: string; redacted: boolean; untrustedContent: true; reasons: string[]; }
export function sanitizeUntrustedText(input: string, allowSensitive = false): SafeText {
  if (allowSensitive) return { text: input, redacted: false, untrustedContent: true, reasons: [] };
  let text = input; const reasons: string[] = [];
  for (const pattern of SECRET_PATTERNS) { const global = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`); const redacted = text.replace(global, "[REDACTED_SECRET]"); if (redacted !== text) { text = redacted; reasons.push("secret_pattern"); } }
  for (const pattern of PII_PATTERNS) { const redacted = text.replace(pattern, "[REDACTED_PII]"); if (redacted !== text) { text = redacted; reasons.push("pii_pattern"); pattern.lastIndex = 0; } }
  return { text, redacted: reasons.length > 0, untrustedContent: true, reasons: [...new Set(reasons)] };
}
export function isPromptLikeContent(input: string): boolean { return /ignore\s+(?:all|previous)\s+instructions|system\s+message/i.test(input); }
