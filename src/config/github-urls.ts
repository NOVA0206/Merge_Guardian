import { ConfigError } from "@/errors";

function checked(name: string, value: string | undefined, fallback: string): string {
  const v = (value ?? fallback).replace(/\/$/, "");
  // Production must talk to GitHub over TLS. Plain http is only allowed for local development and tests.
  if (process.env.NODE_ENV === "production" && process.env.GUARDIAN_ALLOW_INSECURE_GITHUB_URL !== "1" && !v.startsWith("https://")) {
    throw new ConfigError(`${name} must be an https URL in production`);
  }
  return v;
}

/** REST API base. Override (GITHUB_API_URL) for GitHub Enterprise Server; Actions sets it automatically. */
export const githubApiUrl = (): string => checked("GITHUB_API_URL", process.env.GITHUB_API_URL, "https://api.github.com");

/** Web base used for OAuth. Override (GITHUB_WEB_URL) for GitHub Enterprise Server. */
export const githubWebUrl = (): string => checked("GITHUB_WEB_URL", process.env.GITHUB_WEB_URL, "https://github.com");
