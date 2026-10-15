import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";

export const WEBHOOK_SECRET = "e2e-webhook-secret-0123456789";
export const MOCK = "http://127.0.0.1:54330";

export const sha = (n: number) => n.toString(16).padStart(40, "0");
let deliveryCounter = 0;
export const deliveryId = () => `e2e-${Date.now()}-${++deliveryCounter}`;

export async function mock(request: APIRequestContext, path: string, body: unknown = {}) {
  const res = await request.post(`${MOCK}/__mock/${path}`, { data: body });
  expect(res.ok(), `mock ${path}`).toBe(true);
}

export async function recorded(request: APIRequestContext) {
  const res = await request.get(`${MOCK}/__mock/recorded`);
  return (await res.json()) as { checks: Array<{ id: number; head_sha: string; status: string; conclusion: string | null; output?: { title?: string; summary?: string } }>; comments: Array<{ id: number; issue: number; body: string }>; requests: Array<{ method: string; path: string }> };
}

/** POST a webhook exactly as GitHub would: HMAC-SHA256 over the raw body. */
export async function sendWebhook(request: APIRequestContext, event: string, payload: unknown, opts: { delivery?: string; secret?: string; signature?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const signature = opts.signature === undefined ? "sha256=" + createHmac("sha256", opts.secret ?? WEBHOOK_SECRET).update(raw).digest("hex") : opts.signature;
  const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": opts.delivery ?? deliveryId() };
  if (signature) headers["x-hub-signature-256"] = signature;
  return request.post("/api/github/webhook", { data: raw, headers });
}

export const installationPayload = () => ({
  action: "created",
  installation: { id: 99, account: { login: "acme", type: "Organization" } },
  repositories: [{ id: 1, full_name: "acme/app", default_branch: "main" }],
});

export const prPayload = (action: string, number: number, headSha: string, headRef = "feature/dev-one-change") => ({
  action,
  number,
  pull_request: { number, state: "open", head: { sha: headSha, ref: headRef }, base: { sha: "a".repeat(40), ref: "main" }, user: { login: "dev-one" } },
  repository: { id: 1, full_name: "acme/app", default_branch: "main" },
  installation: { id: 99 },
});

/** Complete the real OAuth round-trip (authorize -> callback -> session cookie) against the mock GitHub. */
export async function signIn(page: Page, returnTo = "/dashboard") {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.waitForURL(`**${returnTo}`);
}

export interface JobRow {
  id: string;
  prNumber: number;
  headSha: string;
  status: string;
  decision?: string;
  error?: string;
  attempt: number;
  trigger: string;
}

export async function jobs(page: Page): Promise<JobRow[]> {
  const res = await page.request.get("/api/jobs");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { jobs: JobRow[] }).jobs;
}

/** Poll the persisted job list (the same data the dashboard shows) until `predicate` holds. */
export async function waitForJob(page: Page, headSha: string, predicate: (j: JobRow) => boolean, timeoutMs = 90_000): Promise<JobRow> {
  let last: JobRow | undefined;
  await expect
    .poll(
      async () => {
        last = (await jobs(page)).filter((j) => j.headSha === headSha).sort((a, b) => b.attempt - a.attempt)[0];
        return last !== undefined && predicate(last);
      },
      { timeout: timeoutMs, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return last!;
}
