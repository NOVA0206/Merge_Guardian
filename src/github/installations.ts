import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { getEnv } from "@/config/env";
import { githubApiUrl } from "@/config/github-urls";
import type { Store } from "@/storage/store";
import { createOctokit } from "./client";

/** Octokit authenticated as the GitHub App itself (JWT), for app-level endpoints such as GET /app/installations/:id. */
export function createAppOctokit(): Octokit {
  const env = getEnv();
  return new Octokit({ authStrategy: createAppAuth, auth: { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, baseUrl: githubApiUrl(), userAgent: "github-merge-guardian" });
}

/** Pull an installation and its accessible repositories into the database (used after the install redirect). */
export async function syncInstallation(installationId: number, store: Store): Promise<{ account: string; repositories: number }> {
  const app = createAppOctokit();
  const inst = (await app.rest.apps.getInstallation({ installation_id: installationId })).data;
  const account = inst.account && "login" in inst.account ? inst.account.login : "unknown";
  await store.upsertInstallation({ id: installationId, accountLogin: account, accountType: inst.target_type, suspended: Boolean(inst.suspended_at) });
  const octokit = createOctokit(installationId, "analysis");
  const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
  for (const r of repos) await store.upsertRepository({ id: r.id, installationId, fullName: r.full_name, defaultBranch: r.default_branch ?? "main", enabled: true });
  await store.appendAudit({ actor: "system", action: "installation.synced", details: { installationId, account, repositories: repos.length } });
  return { account, repositories: repos.length };
}
