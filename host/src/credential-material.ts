const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{16,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  /\b(?=[A-Za-z0-9._~+/=-]{32,}\b)(?=[A-Za-z0-9._~+/=-]*[A-Z])(?=[A-Za-z0-9._~+/=-]*[a-z])(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{32,}\b/g,
];

export function redactCredentialText(source: string): { text: string; redacted: boolean } {
  let text = source;
  for (const pattern of CREDENTIAL_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return { text, redacted: text !== source };
}

export function containsCredentialMaterial(source: string): boolean {
  return redactCredentialText(source).redacted;
}
