import { beforeEach, describe, expect, it } from "vitest";
import { handleWebhook, type WebhookDeps } from "@/jobs/webhook-handler";
import { signGitHubPayload } from "@/security/webhook";
import { MemoryStore } from "@/storage/memory";
import type { AnalysisJob } from "@/storage/store";
import { makeFinding } from "@/reporting/finding-schema";
import { FakeGitHub, makePr } from "../helpers/fake-github";
import { baseApp, HEAD_SHA } from "../helpers/fixture";

const SECRET = "whsec_test_secret_0123456789";
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

let store: MemoryStore;
let dispatched: AnalysisJob[];
let github: FakeGitHub;
let deps: WebhookDeps;

beforeEach(async () => {
  store = new MemoryStore();
  dispatched = [];
  github = new FakeGitHub({ pr: makePr(SHA1), base: baseApp(), head: baseApp(), reviews: [], checks: [], permissions: { writer: "write", reader: "read" } });
  deps = { store, webhookSecret: SECRET, dispatch: async (j) => void dispatched.push(j), gatewayFor: () => github, repairEnabled: true };
  await store.upsertInstallation({ id: 99, accountLogin: "acme", accountType: "Organization", suspended: false });
  await store.upsertRepository({ id: 1, installationId: 99, fullName: "acme/app", defaultBranch: "main", enabled: true });
});

const send = (event: string, payload: unknown, delivery = "d-" + Math.random(), secret = SECRET) => {
  const rawBody = JSON.stringify(payload);
  return handleWebhook({ rawBody, event, deliveryId: delivery, signature: signGitHubPayload(rawBody, secret) }, deps);
};
const prEvent = (action: string, head = SHA1, over: Record<string, unknown> = {}) => ({
  action,
  number: 7,
  pull_request: { number: 7, state: "open", head: { sha: head, ref: "feature/x" }, base: { sha: "a".repeat(40), ref: "main" }, user: { login: "dev-one" } },
  repository: { id: 1, full_name: "acme/app", default_branch: "main" },
  installation: { id: 99 },
  ...over,
});

describe("webhook authentication", () => {
  it("rejects bad, missing and wrong-secret signatures without side effects", async () => {
    const raw = JSON.stringify(prEvent("opened"));
    expect((await handleWebhook({ rawBody: raw, event: "pull_request", deliveryId: "x1", signature: "sha256=" + "0".repeat(64) }, deps)).status).toBe(401);
    expect((await handleWebhook({ rawBody: raw, event: "pull_request", deliveryId: "x2", signature: null }, deps)).status).toBe(401);
    expect((await send("pull_request", prEvent("opened"), "x3", "another-secret-value-123456")).status).toBe(401);
    expect(await store.listJobs({})).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  });

  it("verifies against the RAW body: a re-serialised/tampered body fails", async () => {
    const raw = JSON.stringify(prEvent("opened"));
    const sig = signGitHubPayload(raw, SECRET);
    const tampered = raw.replace("feature/x", "feature/y");
    expect((await handleWebhook({ rawBody: tampered, event: "pull_request", deliveryId: "t", signature: sig }, deps)).status).toBe(401);
  });

  it("answers ping and ignores unknown events", async () => {
    expect((await send("ping", { zen: "x" })).body).toMatchObject({ pong: true });
    expect((await send("star", { a: 1 })).body).toMatchObject({ ignored: expect.any(String) });
  });
});

describe("Scenario J: duplicate and stale webhooks", () => {
  it("creates exactly one durable job and one dispatch per revision, however often it is delivered", async () => {
    const a = await send("pull_request", prEvent("opened"), "delivery-1");
    const same = await send("pull_request", prEvent("opened"), "delivery-1"); // GitHub retry, same delivery id
    const redelivered = await send("pull_request", prEvent("opened"), "delivery-2"); // manual redelivery, new id
    expect(a.body).toMatchObject({ created: true });
    expect(same.body).toMatchObject({ duplicate: true });
    expect(redelivered.body).toMatchObject({ created: false });
    expect(await store.listJobs({})).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ repoFullName: "acme/app", prNumber: 7, headSha: SHA1, baseSha: "a".repeat(40), status: "queued" });
  });

  it("a new commit supersedes queued work for the old head so it can never satisfy the check", async () => {
    await send("pull_request", prEvent("opened", SHA1));
    await send("pull_request", prEvent("synchronize", SHA2));
    const jobs = await store.listJobs({});
    expect(jobs.find((j) => j.headSha === SHA1)?.status).toBe("stale");
    expect(jobs.find((j) => j.headSha === SHA2)?.status).toBe("queued");
    expect((await store.getPrState("acme/app", 7))?.latestHeadSha).toBe(SHA2);
  });

  it("a failed dispatch does not lose the job (swept later) and does not fail the webhook", async () => {
    deps.dispatch = async () => {
      throw new Error("inngest down");
    };
    const res = await send("pull_request", prEvent("opened"));
    expect(res.status).toBe(200);
    expect((await store.listJobs({}))[0]?.status).toBe("queued");
    expect((await store.listAudit({})).some((a) => a.action === "dispatch.deferred")).toBe(true);
  });

  it("processing errors un-record the delivery so GitHub's retry is not swallowed", async () => {
    const original = store.enqueueJob.bind(store);
    store.enqueueJob = async () => {
      throw new Error("db down");
    };
    expect((await send("pull_request", prEvent("opened"), "flaky")).status).toBe(500);
    store.enqueueJob = original;
    expect((await send("pull_request", prEvent("opened"), "flaky")).body).toMatchObject({ created: true });
  });

  it("malformed signed payloads get 400 (not an infinite retry loop)", async () => {
    expect((await send("pull_request", { action: "opened" })).status).toBe(400);
  });
});

describe("repository authorization", () => {
  it("ignores repositories that were not installed/enabled, or whose installation id does not match", async () => {
    const unknown = prEvent("opened", SHA1, { repository: { id: 2, full_name: "evil/repo" } });
    expect((await send("pull_request", unknown)).body).toMatchObject({ ignored: expect.stringContaining("not installed") });
    expect((await send("pull_request", prEvent("opened", SHA1, { installation: { id: 12345 } }))).body).toMatchObject({ ignored: expect.any(String) });
    await store.setRepositoryEnabled("acme/app", false);
    expect((await send("pull_request", prEvent("opened"))).body).toMatchObject({ ignored: expect.any(String) });
    expect(await store.listJobs({})).toHaveLength(0);
  });

  it("registers installations and repositories from installation events; removal revokes access", async () => {
    await send("installation", { action: "created", installation: { id: 500, account: { login: "newco", type: "User" } }, repositories: [{ id: 50, full_name: "newco/site" }] });
    expect((await store.getRepository("newco/site"))?.installationId).toBe(500);
    await send("installation_repositories", { action: "removed", installation: { id: 500, account: { login: "newco", type: "User" } }, repositories_removed: [{ id: 50, full_name: "newco/site" }] });
    expect((await store.getRepository("newco/site"))?.enabled).toBe(false);
    await send("installation", { action: "deleted", installation: { id: 500, account: { login: "newco", type: "User" } } });
    expect(await store.getRepository("newco/site")).toBeUndefined();
  });
});

describe("re-evaluation triggers", () => {
  beforeEach(async () => {
    await send("pull_request", prEvent("opened", SHA1));
  });

  it("an approving review on the current head enqueues one evaluation job (deduped)", async () => {
    const review = { action: "submitted", review: { id: 77, state: "approved", commit_id: SHA1 }, pull_request: { number: 7, head: { sha: SHA1 } }, repository: { id: 1, full_name: "acme/app" }, installation: { id: 99 } };
    expect((await send("pull_request_review", review, "r1")).body).toMatchObject({ created: true });
    expect((await send("pull_request_review", review, "r2")).body).toMatchObject({ created: false });
    expect((await store.listJobs({})).filter((j) => j.trigger === "evaluate")).toHaveLength(1);
  });

  it("ignores reviews and checks for outdated heads", async () => {
    await send("pull_request", prEvent("synchronize", SHA2));
    const stale = { action: "submitted", review: { id: 78, state: "approved" }, pull_request: { number: 7, head: { sha: SHA1 } }, repository: { id: 1, full_name: "acme/app" }, installation: { id: 99 } };
    expect((await send("pull_request_review", stale)).body).toMatchObject({ ignored: expect.any(String) });
    const check = { action: "completed", check_run: { id: 5, name: "unit-tests", head_sha: SHA1, conclusion: "success", status: "completed" }, repository: { id: 1, full_name: "acme/app" }, installation: { id: 99 } };
    expect((await send("check_run", check)).body).toMatchObject({ ignored: expect.any(String) });
  });

  it("a completed CI check on the current head triggers re-evaluation, but Guardian's own check does not (no loops)", async () => {
    const ci = { action: "completed", check_run: { id: 5, name: "unit-tests", head_sha: SHA1, conclusion: "success", status: "completed" }, repository: { id: 1, full_name: "acme/app" }, installation: { id: 99 } };
    expect((await send("check_run", ci)).body).toMatchObject({ created: true });
    const own = { ...ci, check_run: { ...ci.check_run, id: 6, name: "Guardian / architecture" } };
    expect((await send("check_run", own)).body).toMatchObject({ ignored: expect.any(String) });
  });
});

describe("Scenario I: comment commands and unauthorised repair", () => {
  const comment = (body: string, login = "writer", id = Math.floor(Math.random() * 1e6)) => ({
    action: "created",
    issue: { number: 7, pull_request: {} },
    comment: { id, body, user: { login, type: "User" } },
    repository: { id: 1, full_name: "acme/app" },
    installation: { id: 99 },
  });

  async function jobWithRepairableFinding() {
    await send("pull_request", prEvent("opened", SHA1));
    const job = (await store.listJobs({}))[0]!;
    await store.updateJob(job.id, { status: "succeeded", decision: "BLOCKED" });
    const f = makeFinding({ ruleId: "contract/api-field-removed", category: "api-contract", severity: "P1", confidence: 0.9, kind: "confirmed", title: "t", description: "d", evidence: [], affectedFiles: ["a.ts"], affectedModules: [], potentialImpact: "", recommendedFix: "", requiredTests: [], repairable: true });
    await store.saveFindings(job.id, [f]);
    return f;
  }

  it("a read-only user cannot trigger a repair: no session, no job, denial audited", async () => {
    const f = await jobWithRepairableFinding();
    const before = (await store.listJobs({})).length;
    const res = await send("issue_comment", comment(`/guardian fix ${f.id}`, "reader"));
    expect(res.body).toMatchObject({ denied: true });
    expect(await store.listRepairSessions({ repoFullName: "acme/app" })).toHaveLength(0);
    expect(await store.listJobs({})).toHaveLength(before);
    expect((await store.listAudit({})).some((a) => a.action === "repair.denied" && a.actor === "reader")).toBe(true);
  });

  it("repair requests are denied when repair is disabled for the deployment", async () => {
    deps.repairEnabled = false;
    const f = await jobWithRepairableFinding();
    expect((await send("issue_comment", comment(`/guardian fix ${f.id}`))).body).toMatchObject({ denied: true });
  });

  it("an authorised writer can request a repair for a real, open, repairable finding on the current head", async () => {
    const f = await jobWithRepairableFinding();
    const res = await send("issue_comment", comment(`/guardian fix ${f.id}`));
    expect(res.body).toMatchObject({ created: true });
    const [session] = await store.listRepairSessions({ repoFullName: "acme/app" });
    expect(session).toMatchObject({ status: "requested", sourceHeadSha: SHA1, branch: "guardian/fix-PR-7", requestedBy: "writer" });
    expect((await store.listJobs({})).some((j) => j.trigger === "repair")).toBe(true);
  });

  it("rejects fabricated finding ids, and ignores look-alike or injected comment text", async () => {
    await jobWithRepairableFinding();
    expect((await send("issue_comment", comment("/guardian fix not-a-real-finding"))).body).toMatchObject({ rejected: true });
    expect((await send("issue_comment", comment("please /guardian fix everything; $(rm -rf /)"))).body).toMatchObject({ ignored: expect.any(String) });
    expect((await send("issue_comment", comment("/guardian fix abc; rm -rf /"))).body).toMatchObject({ ignored: expect.any(String) });
    expect(await store.listRepairSessions({ repoFullName: "acme/app" })).toHaveLength(0);
  });

  it("/guardian rerun needs write access", async () => {
    await send("pull_request", prEvent("opened", SHA1));
    expect((await send("issue_comment", comment("/guardian rerun", "reader"))).body).toMatchObject({ denied: true });
    expect((await send("issue_comment", comment("/guardian rerun", "writer"))).body).toMatchObject({ created: true });
  });

  it("HEAD_SHA constant stays referenced (fixtures sanity)", () => {
    expect(HEAD_SHA).toHaveLength(40);
  });
});
