import { z } from "zod";
import { ConfigError } from "@/errors";

const shape = {
  APP_URL: z.url().optional(),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
  GITHUB_APP_CLIENT_ID: z.string().min(1),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  DATABASE_URL: z.string().min(1),
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GUARDIAN_MODEL: z.string().default("claude-sonnet-5-5"),
  GUARDIAN_AI_REQUIRED: z.enum(["true", "false"]).default("false"),
  GUARDIAN_REPAIR_ENABLED: z.enum(["true", "false"]).default("false"),
  GUARDIAN_MAX_SNAPSHOT_MB: z.coerce.number().int().positive().default(60),
  GUARDIAN_ADMIN_LOGINS: z.string().default(""),
};
const schema = z.object(shape);

export type Env = z.infer<typeof schema>;

/** Vercel env UIs often store PEMs with literal "\n" sequences. */
export function normalizePem(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

let cached: Env | undefined;

/** Validate and return server configuration. Throws ConfigError naming bad variables (never values). */
export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env && cached) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new ConfigError(`Invalid or missing environment variables: ${names.join(", ")}`);
  }
  const env = { ...parsed.data, GITHUB_APP_PRIVATE_KEY: normalizePem(parsed.data.GITHUB_APP_PRIVATE_KEY) };
  if (source === process.env) cached = env;
  return env;
}

/** Non-throwing configuration report. Exposes variable NAMES only, never values. */
export function configStatus(source: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(source);
  const problems = parsed.success ? [] : [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
  return {
    ok: parsed.success,
    missing: problems.filter((k) => !source[k]),
    invalid: problems.filter((k) => Boolean(source[k])),
    aiConfigured: Boolean(source.ANTHROPIC_API_KEY),
    jobsConfigured: Boolean(source.INNGEST_EVENT_KEY) || source.NODE_ENV !== "production",
  };
}
