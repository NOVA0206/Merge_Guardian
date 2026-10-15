/** Patterns for credentials that must never be logged, reported, or sent to a model. */
export const SECRET_PATTERNS: ReadonlyArray<{ id: string; label: string; re: RegExp }> = [
  { id: "private-key", label: "Private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "github-token", label: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { id: "github-pat", label: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { id: "aws-access-key", label: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "anthropic-key", label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-key", label: "OpenAI-style API key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: "slack-token", label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "stripe-key", label: "Stripe secret key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { id: "jwt", label: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "db-url-password", label: "Database URL with password", re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/ },
];

export const REDACTED = "[REDACTED]";

export function redactSecrets(input: string, extraSecrets: readonly string[] = []): string {
  let out = input;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, "g"), REDACTED);
  }
  for (const s of extraSecrets) {
    if (s && s.length >= 6) out = out.split(s).join(REDACTED);
  }
  return out;
}

/** Secret values currently configured in the process environment (for exact-match redaction). */
export function configuredSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const hints = /(SECRET|TOKEN|PRIVATE|PASSWORD|API_KEY|DATABASE_URL|SIGNING_KEY)/i;
  return Object.entries(env)
    .filter(([k, v]) => hints.test(k) && typeof v === "string" && v.length >= 8)
    .map(([, v]) => v as string);
}

export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg, configuredSecretValues()).slice(0, 500);
}

export function findSecrets(text: string): Array<{ id: string; label: string; index: number }> {
  const hits: Array<{ id: string; label: string; index: number }> = [];
  for (const { id, label, re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ id, label, index: m.index });
  }
  return hits;
}
