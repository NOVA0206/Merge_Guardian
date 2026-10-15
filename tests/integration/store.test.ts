import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../scripts/migrate";
import { PostgresStore } from "@/storage/postgres";
import { startTestPostgres } from "../e2e/support/postgres";
import { MemoryStore } from "@/storage/memory";
import type { Store } from "@/storage/store";
import { makePgliteStore } from "../helpers/pg";
import { makeFinding } from "@/reporting/finding-schema";

const input = (over: Partial<Parameters<Store["enqueueJob"]>[0]> = {}) => ({
  idempotencyKey: "acme/app#7@" + "b".repeat(40) + ":pull_request",
  repoFullName: "acme/app",
  installationId: 99,
  prNumber: 7,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  trigger: "pull_request" as const,
  ...over,
});

function contract(name: string, factory: () => Promise<Store>, teardown?: () => Promise<void>) {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    afterAll(async () => {
      await teardown?.();
    });
    beforeAll(async () => {
      store = await factory();
      await store.upsertInstallation({ id: 99, accountLogin: "acme", accountType: "Organization", suspended: false });
      await store.upsertRepository({ id: 1, installationId: 99, fullName: "acme/app", defaultBranch: "main", enabled: true });
    });

    it("de-duplicates webhook deliveries", async () => {
      expect(await store.recordDelivery("d-1", "pull_request")).toBe(true);
      expect(await store.recordDelivery("d-1", "pull_request")).toBe(false);
    });

    it("enqueue is idempotent and persists across reads", async () => {
      const a = await store.enqueueJob(input());
      const b = await store.enqueueJob(input());
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.job.id).toBe(a.job.id);
      expect((await store.getJob(a.job.id))?.status).toBe("queued");
      expect((await store.listJobs({ repoFullNames: ["acme/app"] })).length).toBeGreaterThan(0);
    });

    it("only one worker can claim a job; terminal jobs cannot be re-claimed", async () => {
      const { job } = await store.enqueueJob(input({ idempotencyKey: "claim-1" }));
      const [c1, c2] = await Promise.all([store.claimJob(job.id), store.claimJob(job.id)]);
      expect([c1, c2].filter(Boolean)).toHaveLength(1);
      await store.updateJob(job.id, { status: "succeeded", decision: "PASS" });
      expect(await store.claimJob(job.id)).toBeUndefined();
    });

    it("failed jobs retry until max attempts, then need a manual requeue", async () => {
      const { job } = await store.enqueueJob(input({ idempotencyKey: "retry-1", maxAttempts: 2 }));
      expect((await store.claimJob(job.id))?.attempt).toBe(1);
      await store.updateJob(job.id, { status: "failed", error: "boom" });
      expect((await store.claimJob(job.id))?.attempt).toBe(2);
      await store.updateJob(job.id, { status: "failed", error: "boom again" });
      expect(await store.claimJob(job.id)).toBeUndefined();
      const q = await store.requeueJob(job.id);
      expect(q?.status).toBe("queued");
      expect((await store.claimJob(job.id))?.attempt).toBe(3);
    });

    it("supersedes in-flight jobs for older heads", async () => {
      const old = await store.enqueueJob(input({ idempotencyKey: "old-head", prNumber: 8, headSha: "1".repeat(40) }));
      const fresh = await store.enqueueJob(input({ idempotencyKey: "new-head", prNumber: 8, headSha: "2".repeat(40) }));
      const ids = await store.supersedeJobs("acme/app", 8, "2".repeat(40));
      expect(ids).toEqual([old.job.id]);
      expect((await store.getJob(old.job.id))?.status).toBe("stale");
      expect((await store.getJob(fresh.job.id))?.status).toBe("queued");
    });

    it("the sweeper finds lost jobs and exhausted jobs whose failure check was never published", async () => {
      const lost = await store.enqueueJob(input({ idempotencyKey: "sweep-lost" }));
      const exhausted = await store.enqueueJob(input({ idempotencyKey: "sweep-failed", maxAttempts: 1 }));
      await store.claimJob(exhausted.job.id);
      await store.updateJob(exhausted.job.id, { status: "failed", error: "GitHub down" });
      const published = await store.enqueueJob(input({ idempotencyKey: "sweep-published", maxAttempts: 1 }));
      await store.claimJob(published.job.id);
      await store.updateJob(published.job.id, { status: "failed", error: "x", result: { failureCheckPublished: true } });
      await new Promise((r) => setTimeout(r, 1100));
      const ids = (await store.listStuckJobs(0)).map((j) => j.id);
      expect(ids).toContain(lost.job.id);
      expect(ids).toContain(exhausted.job.id);
      expect(ids).not.toContain(published.job.id);
    });

    it("stores job results and findings durably", async () => {
      const { job } = await store.enqueueJob(input({ idempotencyKey: "result-1" }));
      await store.updateJob(job.id, { status: "succeeded", decision: "BLOCKED", result: { reasons: ["x"] }, checkRunId: 123 });
      const f = makeFinding({ ruleId: "arch/module-boundary", category: "architecture-drift", severity: "P1", confidence: 0.9, kind: "confirmed", title: "t", description: "d", evidence: [], affectedFiles: ["a.ts"], affectedModules: [], potentialImpact: "", recommendedFix: "", requiredTests: [] });
      await store.saveFindings(job.id, [f]);
      const got = await store.getJob(job.id);
      expect(got).toMatchObject({ decision: "BLOCKED", checkRunId: 123, result: { reasons: ["x"] } });
      expect((await store.getFindings(job.id))[0]?.id).toBe(f.id);
    });

    it("tracks PR state, audit log and repair sessions", async () => {
      await store.setPrState({ repoFullName: "acme/app", prNumber: 7, latestHeadSha: "b".repeat(40), updatedAt: "" });
      expect((await store.getPrState("acme/app", 7))?.latestHeadSha).toBe("b".repeat(40));
      await store.appendAudit({ actor: "system", action: "job.completed", repoFullName: "acme/app", prNumber: 7, details: { ok: true } });
      expect((await store.listAudit({ repoFullName: "acme/app" }))[0]?.action).toBe("job.completed");
      const rs = await store.createRepairSession({ repoFullName: "acme/app", prNumber: 7, findingId: "f", sourceHeadSha: "b".repeat(40), branch: "guardian/fix-PR-7", status: "requested", requestedBy: "dev" });
      const up = await store.updateRepairSession(rs.id, { status: "proposed", attempts: 1 });
      expect(up).toMatchObject({ status: "proposed", attempts: 1 });
    });
  });
}

contract("MemoryStore", async () => new MemoryStore());
contract("PostgresStore on real PostgreSQL (PGlite) with production migrations", async () => (await makePgliteStore()).store);

// The decisive one: a real PostgreSQL server, real pg.Pool with several connections, and the production migrator.
// Concurrency-sensitive behaviour (atomic claim, idempotent enqueue) is only meaningfully tested here.
let realPg: Awaited<ReturnType<typeof startTestPostgres>> | undefined;
let pool: pg.Pool | undefined;
contract(
  "PostgresStore on real PostgreSQL 17 with a multi-connection pg.Pool",
  async () => {
    realPg = await startTestPostgres(54399);
    await migrate(realPg.url, () => undefined);
    pool = new pg.Pool({ connectionString: realPg.url, max: 5 });
    return new PostgresStore(pool);
  },
  async () => {
    await pool?.end();
    await realPg?.stop();
  },
);

describe("concurrency on real PostgreSQL", () => {
  it("N parallel enqueues of one idempotency key create exactly one job; N parallel claims win exactly once", async () => {
    const server = await startTestPostgres(54398);
    await migrate(server.url, () => undefined);
    const p = new pg.Pool({ connectionString: server.url, max: 10 });
    try {
      const store = new PostgresStore(p);
      const results = await Promise.all(Array.from({ length: 12 }, () => store.enqueueJob(input({ idempotencyKey: "race-key" }))));
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
      const claims = await Promise.all(Array.from({ length: 12 }, () => store.claimJob(results[0]!.job.id)));
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await Promise.all(Array.from({ length: 12 }, () => store.recordDelivery("same-delivery", "pull_request"))).then((r) => r.filter(Boolean).length)).toBe(1);
    } finally {
      await p.end();
      await server.stop();
    }
  }, 120_000);
});
