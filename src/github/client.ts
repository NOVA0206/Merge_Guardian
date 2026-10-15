import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { getEnv } from "@/config/env";
import { githubApiUrl } from "@/config/github-urls";
import type { GitHubGateway } from "./gateway";
import { OctokitGateway } from "./octokit-gateway";

export type GatewayMode = "analysis" | "repair";

/**
 * Permissions requested for the installation token. Even if the App is granted more, analysis tokens are
 * minted read-only (plus checks/comments); only repair tokens can write contents.
 */
const PERMISSIONS: Record<GatewayMode, Record<string, "read" | "write">> = {
  analysis: { metadata: "read", contents: "read", pull_requests: "write", issues: "write", checks: "write", actions: "read" },
  repair: { metadata: "read", contents: "write", pull_requests: "write" },
};

export function createOctokit(installationId: number, mode: GatewayMode): Octokit {
  const env = getEnv();
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, installationId, permissions: PERMISSIONS[mode] },
    baseUrl: githubApiUrl(),
    userAgent: "github-merge-guardian",
    request: { timeout: 20_000 },
    // `octokit` bundles retry + throttling plugins; keep retries bounded.
    retry: { doNotRetry: [400, 401, 403, 404, 422], retries: 2 },
    throttle: {
      onRateLimit: (retryAfter: number, _o: unknown, _k: unknown, retryCount: number) => retryCount < 1 && retryAfter < 30,
      onSecondaryRateLimit: (retryAfter: number, _o: unknown, _k: unknown, retryCount: number) => retryCount < 1 && retryAfter < 30,
    },
  });
}

export function getGateway(installationId: number, mode: GatewayMode = "analysis"): GitHubGateway {
  return new OctokitGateway(createOctokit(installationId, mode));
}
