export class GuardianError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GuardianError";
  }
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
  get status(): number {
    return this.options.status ?? 500;
  }
}

export class ConfigError extends GuardianError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR", { status: 500 });
    this.name = "ConfigError";
  }
}

export class AuthError extends GuardianError {
  constructor(message: string, status = 401) {
    super(message, "AUTH_ERROR", { status });
    this.name = "AuthError";
  }
}

export class StaleRevisionError extends GuardianError {
  constructor(message = "Pull request head moved; analysis is stale") {
    super(message, "STALE_REVISION", { status: 409 });
    this.name = "StaleRevisionError";
  }
}

export class ValidationError extends GuardianError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", { status: 400 });
    this.name = "ValidationError";
  }
}

export class PolicyViolationError extends GuardianError {
  constructor(message: string) {
    super(message, "POLICY_VIOLATION", { status: 403 });
    this.name = "PolicyViolationError";
  }
}

/** True for failures worth retrying: network resets, timeouts, 5xx and rate limits. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof GuardianError) return err.retryable;
  const e = err as { status?: number; code?: string; name?: string; message?: string } | undefined;
  if (!e) return false;
  if (typeof e.status === "number") return e.status >= 500 || e.status === 429 || e.status === 408;
  if (e.code && /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR.*)$/.test(e.code)) return true;
  return e.name === "AbortError" || /fetch failed|socket hang up|timeout/i.test(e.message ?? "");
}
