import { z } from "zod";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const deploymentSchema = z.object({ id: z.number(), sha: z.string(), environment: z.string(), creator: z.object({ login: z.string() }).optional(), created_at: z.string() });
const statusSchema = z.object({ state: z.string(), environment_url: z.string().optional(), target_url: z.string().optional(), created_at: z.string() });

export interface PreviewResolution {
  ok: boolean;
  url?: string;
  deploymentId?: number;
  /** Why it is not ok. Unavailable/stale/missing previews are reported, never treated as success. */
  reason?: string;
}

export interface ResolvePreviewOptions {
  repo: string; // owner/name
  sha: string;
  token: string;
  /** Login of the deploying integration; defaults to Vercel's GitHub app. */
  expectedCreators?: string[];
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const URL_OK = /^https:\/\/[a-z0-9.-]+\.vercel\.app\/?$|^https:\/\/[a-z0-9.-]+$/i;

/**
 * Find the Vercel preview deployment for EXACTLY this commit via the GitHub Deployments API (Vercel reports
 * every deployment there). A deployment for another SHA, another repository, or an unknown creator is rejected.
 */
export async function resolvePreviewDeployment(o: ResolvePreviewOptions): Promise<PreviewResolution> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const creators = (o.expectedCreators ?? ["vercel[bot]", "vercel"]).map((c) => c.toLowerCase());
  const deadline = now() + (o.timeoutMs ?? 10 * 60_000);
  const headers = { authorization: `Bearer ${o.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "github-merge-guardian" };
  let last = "no deployment found for this commit yet";

  while (true) {
    const res = await f(`https://api.github.com/repos/${o.repo}/deployments?sha=${o.sha}&per_page=20`, { headers });
    if (!res.ok) return { ok: false, reason: `GitHub deployments API returned ${res.status}` };
    const deployments = z.array(deploymentSchema).parse(await res.json());
    const candidates = deployments
      .filter((d) => d.sha === o.sha && /preview/i.test(d.environment) && (!d.creator || creators.includes(d.creator.login.toLowerCase())))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    for (const d of candidates) {
      const sres = await f(`https://api.github.com/repos/${o.repo}/deployments/${d.id}/statuses?per_page=10`, { headers });
      if (!sres.ok) return { ok: false, reason: `deployment statuses API returned ${sres.status}` };
      const statuses = z.array(statusSchema).parse(await sres.json()).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const latest = statuses[0];
      if (!latest) {
        last = `deployment ${d.id} has no status yet`;
        continue;
      }
      if (latest.state === "success") {
        const url = latest.environment_url ?? latest.target_url;
        if (!url || !URL_OK.test(url)) return { ok: false, reason: `deployment ${d.id} reported an unusable URL` };
        return { ok: true, url: url.replace(/\/$/, ""), deploymentId: d.id };
      }
      if (["failure", "error", "inactive"].includes(latest.state)) return { ok: false, deploymentId: d.id, reason: `Vercel deployment ${d.id} ended in state "${latest.state}"` };
      last = `deployment ${d.id} is ${latest.state}`;
    }
    if (now() >= deadline) return { ok: false, reason: `Timed out waiting for a preview deployment of ${o.sha.slice(0, 7)}: ${last}` };
    await sleep(o.intervalMs ?? 10_000);
  }
}

export interface HealthExpectation {
  url: string;
  expectedSha: string;
  /** Header for Vercel "Protection Bypass for Automation". Sent only to the resolved preview host. */
  bypassToken?: string;
  fetchImpl?: FetchLike;
}

/**
 * Prove the deployed code is the commit under test: the app's /api/health must report that same SHA
 * (Vercel injects VERCEL_GIT_COMMIT_SHA). A healthy deployment of a different commit is a failure.
 */
export async function verifyDeployedCommit(o: HealthExpectation): Promise<{ ok: boolean; reason?: string; reported?: string }> {
  const f = o.fetchImpl ?? fetch;
  const res = await f(`${o.url}/api/health`, { headers: o.bypassToken ? { "x-vercel-protection-bypass": o.bypassToken } : {}, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) return { ok: false, reason: `health endpoint redirected (${res.status}); deployment protection may be blocking automation` };
  const body = (await res.json().catch(() => null)) as { commit?: string; status?: string } | null;
  if (!body) return { ok: false, reason: `health endpoint returned HTTP ${res.status} without JSON` };
  if (!body.commit) return { ok: false, reason: "health endpoint does not report a commit SHA, so the deployment cannot be matched to the PR revision" };
  if (body.commit !== o.expectedSha) return { ok: false, reported: body.commit, reason: `deployment serves ${body.commit.slice(0, 7)}, expected ${o.expectedSha.slice(0, 7)} (stale or wrong deployment)` };
  return { ok: true, reported: body.commit };
}
