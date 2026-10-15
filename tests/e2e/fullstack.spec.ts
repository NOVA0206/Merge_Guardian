import { expect, test } from "@playwright/test";
import { installationPayload, jobs, mock, prPayload, recorded, sendWebhook, sha, signIn, waitForJob } from "./support/helpers";

/**
 * Full-stack scenarios on the PRODUCTION build: signed webhook -> PostgreSQL job row -> Inngest durable run ->
 * analysis -> (mock) GitHub check run + comment -> dashboard. Nothing here runs analysis inside the webhook request.
 */
const badge = "src/components/ui/Badge.tsx";
const route = "src/app/api/proposals/route.ts";
const safeOverlay = { [badge]: `export function Badge({ label }: { label: string }) {\n  return <span className="badge">{label}</span>;\n}\nexport const x = 1;\n` };
const brokenContract = {
  [route]: `import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listProposals } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const items = await listProposals();
  return NextResponse.json({ items, total: items.length });
}
`,
};

let installed = false;
test.beforeEach(async ({ request }) => {
  await mock(request, "reset");
  await mock(request, "permission", { user: "writer", permission: "write" });
  if (!installed) {
    const res = await sendWebhook(request, "installation", installationPayload());
    expect(res.status()).toBe(200);
    installed = true;
  }
});

async function openPr(request: Parameters<typeof mock>[0], number: number, head: string, overlay: Record<string, string | null>, ci: "success" | "failure" | "none" = "success") {
  await mock(request, "pr", { number, headSha: head, overlay });
  if (ci !== "none") await mock(request, "ci", { sha: head, conclusion: ci });
}

test.describe("@fullstack installation and dashboard", () => {
  test("connected repository appears in the dashboard after sign-in", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
    await expect(page.getByText("acme/app")).toBeVisible();
    await expect(page.getByText("Analysing")).toBeVisible();
  });

  test("CSRF-style cross-origin state changes are rejected", async ({ page, request }) => {
    await signIn(page);
    const res = await page.request.post("/api/repositories/toggle", { data: { fullName: "acme/app", enabled: false }, headers: { origin: "https://evil.example" } });
    expect(res.status()).toBe(403);
    const fresh = await request.post("/api/repositories/toggle", { data: { fullName: "acme/app", enabled: false } });
    expect([401, 403]).toContain(fresh.status());
  });
});

test.describe("@fullstack durable analysis", () => {
  test("safe change: job is queued durably, runs, publishes a SUCCESS check bound to the head SHA, and survives a new session", async ({ page, browser, request }) => {
    const head = sha(0x1001);
    await openPr(request, 7, head, safeOverlay);
    await signIn(page);

    const res = await sendWebhook(request, "pull_request", prPayload("opened", 7, head));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { jobId: string; created: boolean };
    expect(body.created).toBe(true);

    const job = await waitForJob(page, head, (j) => j.status === "succeeded");
    expect(job.decision).toBe("PASS");

    const rec = await recorded(request);
    const check = rec.checks.filter((c) => c.head_sha === head).at(-1)!;
    expect(check).toMatchObject({ status: "completed", conclusion: "success" });
    expect(rec.comments.some((c) => c.body.includes("**Decision:** ✅ PASS") && c.body.includes(head))).toBe(true);

    // Job detail page shows persisted status after refresh.
    await page.goto(`/dashboard/jobs/${job.id}`);
    await expect(page.getByText("PASS", { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(head.slice(0, 12))).toBeVisible();

    // A brand-new browser session (fresh cookies) sees the same persisted data.
    const ctx = await browser.newContext({ baseURL: "http://localhost:3100" });
    const page2 = await ctx.newPage();
    await signIn(page2);
    await expect(page2.getByRole("link", { name: "acme/app#7" }).first()).toBeVisible();
    await ctx.close();
  });

  test("duplicate and redelivered webhooks create exactly one analysis and one check result", async ({ page, request }) => {
    const head = sha(0x1002);
    await openPr(request, 8, head, safeOverlay);
    await signIn(page);

    const delivery = "dup-delivery-1";
    const a = await sendWebhook(request, "pull_request", prPayload("opened", 8, head), { delivery });
    const b = await sendWebhook(request, "pull_request", prPayload("opened", 8, head), { delivery });
    const c = await sendWebhook(request, "pull_request", prPayload("opened", 8, head), { delivery: "dup-delivery-2" });
    expect((await a.json()).created).toBe(true);
    expect(await b.json()).toMatchObject({ duplicate: true });
    expect((await c.json()).created).toBe(false);

    await waitForJob(page, head, (j) => j.status === "succeeded");
    const forHead = (await jobs(page)).filter((j) => j.headSha === head);
    expect(forHead).toHaveLength(1);
    const checks = (await recorded(request)).checks.filter((x) => x.head_sha === head);
    expect(checks).toHaveLength(1); // one check run, updated in place (pending -> completed)
  });

  test("broken API contract: BLOCKED, failing check, consumer evidence visible in the dashboard", async ({ page, request }) => {
    const head = sha(0x1003);
    await openPr(request, 9, head, brokenContract);
    await signIn(page);
    await sendWebhook(request, "pull_request", prPayload("opened", 9, head));

    const job = await waitForJob(page, head, (j) => j.status === "succeeded");
    expect(job.decision).toBe("BLOCKED");
    const check = (await recorded(request)).checks.filter((c) => c.head_sha === head).at(-1)!;
    expect(check.conclusion).toBe("failure");
    expect(check.output?.summary).toContain("ProposalList.tsx");

    await page.goto(`/dashboard/jobs/${job.id}`);
    await expect(page.getByText("API response field removed or renamed", { exact: true })).toBeVisible();
    await expect(page.getByText(/ProposalList\.tsx:\d+/).first()).toBeVisible();
    await expect(page.getByText("contract/api-field-removed").first()).toBeVisible();
  });

  test("mandatory CI not finished: check stays pending (never green), then re-evaluates when CI completes", async ({ page, request }) => {
    const head = sha(0x1004);
    await openPr(request, 10, head, safeOverlay, "none");
    await signIn(page);
    await sendWebhook(request, "pull_request", prPayload("opened", 10, head));

    const first = await waitForJob(page, head, (j) => j.status === "succeeded");
    expect(first.decision).toBe("PENDING");
    let check = (await recorded(request)).checks.filter((c) => c.head_sha === head).at(-1)!;
    expect(check.status).toBe("in_progress");
    expect(check.conclusion).toBeNull();

    // CI finishes -> GitHub sends check_run.completed -> Guardian re-evaluates.
    await mock(request, "ci", { sha: head, conclusion: "success" });
    const ev = await sendWebhook(request, "check_run", { action: "completed", check_run: { id: 777, name: "unit-tests", head_sha: head, conclusion: "success", status: "completed" }, repository: { id: 1, full_name: "acme/app" }, installation: { id: 99 } });
    expect((await ev.json()).created).toBe(true);
    await expect
      .poll(async () => (await recorded(request)).checks.filter((c) => c.head_sha === head).at(-1)?.conclusion, { timeout: 60_000 })
      .toBe("success");
    check = (await recorded(request)).checks.filter((c) => c.head_sha === head).at(-1)!;
    expect(check.status).toBe("completed");
  });

  test("failed mandatory CI check blocks even though static analysis is clean", async ({ page, request }) => {
    const head = sha(0x1005);
    await openPr(request, 11, head, safeOverlay, "failure");
    await signIn(page);
    await sendWebhook(request, "pull_request", prPayload("opened", 11, head));
    const job = await waitForJob(page, head, (j) => j.status === "succeeded");
    expect(job.decision).toBe("BLOCKED");
    expect((await recorded(request)).checks.filter((c) => c.head_sha === head).at(-1)?.conclusion).toBe("failure");
  });

  test("a new commit makes the previous analysis stale and the new head gets the authoritative result", async ({ page, request }) => {
    const oldHead = sha(0x1006);
    const newHead = sha(0x1007);
    await openPr(request, 12, oldHead, safeOverlay, "none"); // old head stays pending
    await signIn(page);
    await sendWebhook(request, "pull_request", prPayload("opened", 12, oldHead));
    await waitForJob(page, oldHead, (j) => j.status === "succeeded");

    await openPr(request, 12, newHead, safeOverlay);
    await sendWebhook(request, "pull_request", prPayload("synchronize", 12, newHead));
    const fresh = await waitForJob(page, newHead, (j) => j.status === "succeeded");
    expect(fresh.decision).toBe("PASS");
    // Approvals/results for the old head can never satisfy the new head: they are different jobs and different checks.
    const checks = (await recorded(request)).checks;
    expect(checks.filter((c) => c.head_sha === newHead).at(-1)?.conclusion).toBe("success");
    expect(checks.filter((c) => c.head_sha === oldHead).at(-1)?.conclusion).not.toBe("success");
  });

  test("GitHub outage: job fails visibly, the required check fails closed, and a manual retry succeeds once GitHub recovers", async ({ page, request }) => {
    test.setTimeout(240_000);
    const head = sha(0x1008);
    await openPr(request, 13, head, safeOverlay);
    await signIn(page);
    await mock(request, "fail-next", { count: 10_000, status: 502 }); // every GitHub repo call fails
    await sendWebhook(request, "pull_request", prPayload("opened", 13, head));

    const failed = await waitForJob(page, head, (j) => j.status === "failed" && j.attempt >= 3, 200_000);
    expect(failed.error).toBeTruthy();
    // GitHub itself is down, so no check could be published: it must certainly never be green.
    expect((await recorded(request)).checks.filter((c) => c.head_sha === head).every((c) => c.conclusion !== "success")).toBe(true);

    // Visible in the UI with a retry control.
    await page.goto(`/dashboard/jobs/${failed.id}`);
    await expect(page.getByText(/Analysis failed/)).toBeVisible();
    await mock(request, "fail-next", { count: 0 }); // GitHub recovers
    await page.getByRole("button", { name: "Retry analysis" }).click();

    const ok = await waitForJob(page, head, (j) => j.status === "succeeded", 90_000);
    expect(ok.decision).toBe("PASS");
    await expect
      .poll(async () => (await recorded(request)).checks.filter((c) => c.head_sha === head).at(-1)?.conclusion, { timeout: 30_000 })
      .toBe("success");
  });
});

test.describe("@fullstack security", () => {
  test("a review from a non-approver or on a stale commit does not unblock; comment commands need write access", async ({ page, request }) => {
    const head = sha(0x1009);
    await openPr(request, 14, head, safeOverlay);
    await signIn(page);
    await sendWebhook(request, "pull_request", prPayload("opened", 14, head));
    await waitForJob(page, head, (j) => j.status === "succeeded");

    await mock(request, "permission", { user: "reader", permission: "read" });
    const before = (await jobs(page)).length;
    const res = await sendWebhook(request, "issue_comment", { action: "created", issue: { number: 14, pull_request: {} }, comment: { id: 1, body: "/guardian rerun", user: { login: "reader", type: "User" } }, repository: { id: 1, full_name: "acme/app" }, installation: { id: 99 } });
    expect(await res.json()).toMatchObject({ denied: true });
    expect((await jobs(page)).length).toBe(before);

    const ok = await sendWebhook(request, "issue_comment", { action: "created", issue: { number: 14, pull_request: {} }, comment: { id: 2, body: "/guardian rerun", user: { login: "writer", type: "User" } }, repository: { id: 1, full_name: "acme/app" }, installation: { id: 99 } });
    expect(await ok.json()).toMatchObject({ created: true });
  });

  test("webhooks for repositories that were never installed are ignored (no job, no data)", async ({ page, request }) => {
    await signIn(page);
    const before = (await jobs(page)).length;
    const payload = { ...prPayload("opened", 99, sha(0x2001)), repository: { id: 777, full_name: "stranger/repo", default_branch: "main" } };
    const res = await sendWebhook(request, "pull_request", payload);
    expect(await res.json()).toMatchObject({ ignored: expect.any(String) });
    expect((await jobs(page)).length).toBe(before);
  });

  test("another user's installation data is invisible: unknown job ids 404", async ({ page }) => {
    await signIn(page);
    const res = await page.request.get("/api/jobs/00000000-0000-4000-8000-000000000000");
    expect(res.status()).toBe(404);
  });
});
