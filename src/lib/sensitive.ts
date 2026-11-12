/**
 * Heuristic filter that stops credentials and similar data from being written
 * to persistent memory. Errs on the side of refusing.
 */
const PATTERNS: RegExp[] = [
  /\b(password|passwd|pwd|passcode|pin code|api[_ -]?key|secret|token|private key|seed phrase|recovery phrase)\b/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/, // OpenAI/Anthropic-style keys
  /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b/, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN shape
  /\b[A-Z]{2}\d{6}[A-D]\b/i, // UK NI number shape
];

/** Luhn check so random long numbers aren't all flagged as cards. */
function hasCardNumber(s: string): boolean {
  const runs = s.match(/(?:\d[ -]?){13,19}/g) ?? [];
  return runs.some((run) => {
    const digits = run.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = Number(digits[i]);
      if (dbl) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  });
}

export function looksSensitive(...parts: string[]): boolean {
  const text = parts.join(" ");
  return PATTERNS.some((p) => p.test(text)) || hasCardNumber(text);
}
