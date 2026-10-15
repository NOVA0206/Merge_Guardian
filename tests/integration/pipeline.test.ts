import { describe, expect, it } from "vitest";
import { GUARDIAN_CHECK_NAME } from "@/github/checks";
import type { GuardianDeps } from "@/graph/deps";
import { failExhaustedJob, processAnalysisJob, type PipelineDeps } from "@/jobs/pipeline";
import { MemoryStore } from "@/storage/memory";
import { baseApp, overlay, passingChecks, BASE_SHA, HEAD_SHA } from "../helpers/fixture";
import { FakeGitHub, makePr } from "../helpers/fake-github";

function setup() {
  const head = overlay(baseApp(), { "src/components/ui/Badge.tsx": `export const Badge = () => null;\nexport const z = 1;\n` });
  const github = new FakeGitHub({ pr: makePr(HEAD_SHA), base: baseApp(), head, reviews: [], checks: passingChecks(), permissions: {} });
  const store = new MemoryStore();
  const guardian: GuardianDeps = { github, store, guardianVersion: "test", now: () => new Date(), dashboardUrl: (id) => `https://guardian.test/dashboard/jobs/${id}` };
  const deps: PipelineDeps = { guardian };
  const enqueue = (maxAttempts = 3) =>
    store.enqueueJob({ idempotencyKey: "k" + Math.random(), repoFullName: "acme/app", installationId: 99, prNumber: 7, baseSha: BASE_SHA, headSha: HEAD_SHA, trigger: "pull_request", maxAttempts }).then((r) => r.job);
  return { github, store, deps, enqueue };
}

describe("durable job pipeline", () => {
  it("shows a pending required check first, then completes it; job and findings are persisted", async () => {
    const s = setup();
    const job = await s.enqueue();
    const res = await processAnalysisJob(job.id, s.deps);
    expect(res).toMatchObject({ status: "completed", decision: "PASS" });
    expect(s.github.checkRuns).toHaveLength(1); // same check run id was updated, not duplicated
    expect(s.github.checkRuns[0]).toMatchObject({ name: GUARDIAN_CHECK_NAME, status: "completed", conclusion: "success" });
    const saved = await s.store.getJob(job.id);
    expect(saved).toMatchObject({ status: "succeeded", decision: "PASS", attempt: 1, baseSha: BASE_SHA });
    expect(saved?.checkRunId).toBe(s.github.checkRuns[0]!.id);
  });

  it("is idempotent: a second delivery of the same job does nothing", async () => {
    const s = setup();
    const job = await s.enqueue();
    await processAnalysisJob(job.id, s.deps);
    const before = s.github.checkRuns.length;
    expect(await processAnalysisJob(job.id, s.deps)).toMatchObject({ status: "skipped" });
    expect(s.github.checkRuns).toHaveLength(before);
  });

  it("concurrent workers: exactly one runs the job", async () => {
    const s = setup();
    const job = await s.enqueue();
    const results = await Promise.all([processAnalysisJob(job.id, s.deps), processAnalysisJob(job.id, s.deps)]);
    expect(results.filter((r) => r.status === "completed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "skipped")).toHaveLength(1);
  });

  it("a transient failure marks the job failed (visible), rethrows for retry, and the retry succeeds", async () => {
    const s = setup();
    const job = await s.enqueue();
    s.github.failNextWith = Object.assign(new Error("GitHub 502"), { status: 502 });
    await expect(processAnalysisJob(job.id, s.deps)).rejects.toThrow(/502/);
    const failed = await s.store.getJob(job.id);
    expect(failed).toMatchObject({ status: "failed", attempt: 1 });
    expect(failed?.error).toMatch(/502/);
    // the check stays pending (in_progress), never success, while a retry is possible
    expect(s.github.lastCheck?.conclusion).toBeUndefined();

    expect(await processAnalysisJob(job.id, s.deps)).toMatchObject({ status: "completed", decision: "PASS" });
    expect(await s.store.getJob(job.id)).toMatchObject({ status: "succeeded", attempt: 2 });
  });

  it("when retries are exhausted the required check FAILS (fail closed) and the job can be retried manually", async () => {
    const s = setup();
    const job = await s.enqueue(1);
    s.github.failNextWith = Object.assign(new Error("GitHub 503"), { status: 503 });
    await expect(processAnalysisJob(job.id, s.deps)).rejects.toThrow();
    await failExhaustedJob(job.id, "GitHub 503 after retries", s.deps);

    expect(s.github.lastCheck).toMatchObject({ status: "completed", conclusion: "failure", title: "Guardian could not complete analysis" });
    const failed = await s.store.getJob(job.id);
    expect(failed).toMatchObject({ status: "failed" });
    expect(await processAnalysisJob(job.id, s.deps)).toMatchObject({ status: "skipped" }); // budget exhausted

    // Manual retry from the dashboard: requeue grants one more attempt.
    expect((await s.store.requeueJob(job.id))?.status).toBe("queued");
    expect(await processAnalysisJob(job.id, s.deps)).toMatchObject({ status: "completed", decision: "PASS" });
    expect(s.github.lastCheck?.conclusion).toBe("success");
  });

  it("a redelivery after the attempt budget is spent still turns the required check red (never stuck pending)", async () => {
    const s = setup();
    const job = await s.enqueue(1);
    s.github.failNextWith = Object.assign(new Error("GitHub 502"), { status: 502 });
    await expect(processAnalysisJob(job.id, s.deps)).rejects.toThrow();
    expect(s.github.lastCheck?.conclusion).toBeUndefined(); // pending while a retry was possible
    expect(await processAnalysisJob(job.id, s.deps)).toMatchObject({ status: "skipped", reason: expect.stringContaining("exhausted") });
    expect(s.github.lastCheck).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("a late 'retries exhausted' callback never overwrites a job that was retried and succeeded", async () => {
    const s = setup();
    const job = await s.enqueue(1);
    s.github.failNextWith = Object.assign(new Error("GitHub 502"), { status: 502 });
    await expect(processAnalysisJob(job.id, s.deps)).rejects.toThrow();
    await s.store.requeueJob(job.id); // user clicked Retry before the exhausted-callback ran
    expect(await processAnalysisJob(job.id, s.deps)).toMatchObject({ status: "completed", decision: "PASS" });
    expect(s.github.lastCheck?.conclusion).toBe("success");

    await failExhaustedJob(job.id, "late callback", s.deps); // arrives afterwards
    expect(s.github.lastCheck?.conclusion).toBe("success");
    expect(await s.store.getJob(job.id)).toMatchObject({ status: "succeeded", decision: "PASS" });
  });

  it("if the exhausted-callback loses the race mid-publish, the real outcome is restored", async () => {
    const s = setup();
    const job = await s.enqueue(1);
    s.github.failNextWith = Object.assign(new Error("GitHub 502"), { status: 502 });
    await expect(processAnalysisJob(job.id, s.deps)).rejects.toThrow();
    // Simulate: while the failure check is being written, a retry completes.
    const original = s.github.upsertCheckRun.bind(s.github);
    let raced = false;
    s.github.upsertCheckRun = async (i) => {
      const id = await original(i);
      if (!raced && i.conclusion === "failure") {
        raced = true;
        await s.store.requeueJob(job.id);
        await processAnalysisJob(job.id, s.deps); // retry finishes (writes success) ...
        await original(i); // ... and our stale failure write lands after it
      }
      return id;
    };
    await failExhaustedJob(job.id, "late", s.deps);
    expect(s.github.lastCheck?.conclusion).toBe("success");
    expect((await s.store.listAudit({ jobId: job.id })).some((a) => a.action === "check.restored_after_race")).toBe(true);
  });

  it("redacts secret values from persisted errors", async () => {
    const s = setup();
    const job = await s.enqueue();
    const leaked = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0".repeat(2);
    s.github.failNextWith = Object.assign(new Error(`request failed with token ${leaked}`), { status: 500 });
    await expect(processAnalysisJob(job.id, s.deps)).rejects.toThrow();
    const saved = await s.store.getJob(job.id);
    expect(saved?.error).not.toContain(leaked);
    expect(saved?.error).toContain("[REDACTED]");
  });

  it("missing jobs and unknown ids are skipped safely", async () => {
    const s = setup();
    expect(await processAnalysisJob("00000000-0000-0000-0000-000000000000", s.deps)).toMatchObject({ status: "skipped" });
  });
});
