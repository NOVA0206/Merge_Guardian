import { z } from "zod";
import { AuthError } from "@/errors";
import { GUARDIAN_CHECK_NAME } from "@/github/checks";
import type { GitHubGateway } from "@/github/gateway";
import { assertRepairActorAuthorized } from "@/security/permissions";
import { verifyGitHubSignature } from "@/security/webhook";
import { safeErrorMessage } from "@/security/secret-redaction";
import type { AnalysisJob, Store } from "@/storage/store";

export interface WebhookDeps {
  store: Store;
  webhookSecret: string;
  /** Send the durable "run this job" event. Must be cheap; the HTTP response never waits for analysis. */
  dispatch: (job: AnalysisJob) => Promise<void>;
  /** Installation-scoped gateway used only for permission lookups on comment commands. */
  gatewayFor: (installationId: number) => GitHubGateway;
  repairEnabled: boolean;
  repairAllowedActors?: string[];
}

export interface WebhookRequest {
  rawBody: string;
  event: string | null;
  deliveryId: string | null;
  signature: string | null;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

const repo = z.object({ id: z.number(), full_name: z.string(), default_branch: z.string().optional() });
const installation = z.object({ id: z.number() });
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const pullRequestPayload = z.object({
  action: z.string(),
  number: z.number().int(),
  pull_request: z.object({ number: z.number().int(), state: z.string(), head: z.object({ sha, ref: z.string() }), base: z.object({ sha, ref: z.string() }), user: z.object({ login: z.string() }).optional() }),
  repository: repo,
  installation,
});
const reviewPayload = z.object({
  action: z.string(),
  review: z.object({ id: z.number(), state: z.string(), commit_id: z.string().optional() }),
  pull_request: z.object({ number: z.number().int(), head: z.object({ sha }) }),
  repository: repo,
  installation,
});
const checkRunPayload = z.object({
  action: z.string(),
  check_run: z.object({ id: z.number(), name: z.string(), head_sha: sha, conclusion: z.string().nullable().optional(), status: z.string() }),
  repository: repo,
  installation,
});
const installationPayload = z.object({
  action: z.string(),
  installation: z.object({ id: z.number(), account: z.object({ login: z.string(), type: z.string() }), suspended_at: z.string().nullable().optional() }),
  repositories: z.array(repo).optional(),
  repositories_added: z.array(repo).optional(),
  repositories_removed: z.array(repo).optional(),
});
const commentPayload = z.object({
  action: z.string(),
  issue: z.object({ number: z.number().int(), pull_request: z.unknown().optional() }),
  comment: z.object({ id: z.number(), body: z.string(), user: z.object({ login: z.string(), type: z.string().optional() }) }),
  repository: repo,
  installation,
});

const PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited"]);
const COMMAND = /^\/guardian\s+(rerun|fix\s+([A-Za-z0-9_./-]{1,120}))\s*$/;

const ok = (body: Record<string, unknown> = {}): WebhookResult => ({ status: 200, body: { ok: true, ...body } });
const ignored = (reason: string): WebhookResult => ({ status: 200, body: { ok: true, ignored: reason } });

/**
 * Authenticated, idempotent webhook ingestion. Does only cheap, durable work: verify, record, enqueue.
 * Analysis itself runs later in the durable job runner.
 */
export async function handleWebhook(req: WebhookRequest, d: WebhookDeps): Promise<WebhookResult> {
  try {
    verifyGitHubSignature(req.rawBody, req.signature, d.webhookSecret);
  } catch (e) {
    return { status: e instanceof AuthError ? e.status : 401, body: { ok: false, error: "invalid signature" } };
  }
  if (!req.event || !req.deliveryId) return { status: 400, body: { ok: false, error: "missing event or delivery headers" } };

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid JSON" } };
  }

  const fresh = await d.store.recordDelivery(req.deliveryId, req.event);
  if (!fresh) return ok({ duplicate: true });

  try {
    return await route(req.event, payload, req.deliveryId, d);
  } catch (e) {
    if (e instanceof z.ZodError) return { status: 400, body: { ok: false, error: "unsupported payload shape" } }; // retrying cannot help
    await d.store.forgetDelivery(req.deliveryId); // let GitHub's redelivery try again
    console.error("webhook processing failed", req.event, safeErrorMessage(e));
    return { status: 500, body: { ok: false, error: "processing failed; delivery will be retried" } };
  }
}

async function route(event: string, payload: unknown, deliveryId: string, d: WebhookDeps): Promise<WebhookResult> {
  switch (event) {
    case "ping":
      return ok({ pong: true });
    case "installation":
      return onInstallation(installationPayload.parse(payload), d);
    case "installation_repositories":
      return onInstallation(installationPayload.parse({ ...(payload as object) }), d);
    case "pull_request":
      return onPullRequest(pullRequestPayload.parse(payload), deliveryId, d);
    case "pull_request_review":
      return onReview(reviewPayload.parse(payload), deliveryId, d);
    case "check_run":
      return onCheckRun(checkRunPayload.parse(payload), deliveryId, d);
    case "issue_comment":
      return onComment(commentPayload.parse(payload), deliveryId, d);
    default:
      return ignored(`event ${event} is not handled`);
  }
}

async function onInstallation(p: z.infer<typeof installationPayload>, d: WebhookDeps): Promise<WebhookResult> {
  const inst = p.installation;
  if (p.action === "deleted") {
    await d.store.removeInstallation(inst.id);
    await d.store.appendAudit({ actor: "github", action: "installation.deleted", details: { installationId: inst.id } });
    return ok();
  }
  await d.store.upsertInstallation({ id: inst.id, accountLogin: inst.account.login, accountType: inst.account.type, suspended: p.action === "suspend" || Boolean(inst.suspended_at) });
  for (const r of [...(p.repositories ?? []), ...(p.repositories_added ?? [])]) {
    await d.store.upsertRepository({ id: r.id, installationId: inst.id, fullName: r.full_name, defaultBranch: r.default_branch ?? "main", enabled: true });
  }
  for (const r of p.repositories_removed ?? []) await d.store.setRepositoryEnabled(r.full_name, false);
  await d.store.appendAudit({ actor: "github", action: `installation.${p.action}`, details: { installationId: inst.id, account: inst.account.login } });
  return ok();
}

/** Only repositories explicitly installed (and enabled) are analysed; the installation must match. */
async function authorizedRepo(fullName: string, installationId: number, d: WebhookDeps) {
  const r = await d.store.getRepository(fullName);
  if (!r || !r.enabled || r.installationId !== installationId) return undefined;
  return r;
}

async function enqueueAndDispatch(d: WebhookDeps, input: Parameters<Store["enqueueJob"]>[0]) {
  const { job, created } = await d.store.enqueueJob(input);
  if (created) {
    try {
      await d.dispatch(job);
    } catch (e) {
      // The job is durable; the stuck-job sweeper re-dispatches it. Do not fail the webhook.
      await d.store.appendAudit({ actor: "guardian", action: "dispatch.deferred", jobId: job.id, repoFullName: job.repoFullName, prNumber: job.prNumber, details: { error: safeErrorMessage(e) } });
    }
  }
  return { job, created };
}

async function onPullRequest(p: z.infer<typeof pullRequestPayload>, deliveryId: string, d: WebhookDeps): Promise<WebhookResult> {
  const repoRec = await authorizedRepo(p.repository.full_name, p.installation.id, d);
  if (!repoRec) return ignored("repository is not installed/enabled");
  const full = p.repository.full_name;
  const headSha = p.pull_request.head.sha;

  if (p.action === "closed") {
    await d.store.supersedeJobs(full, p.number, "closed");
    return ok({ closed: true });
  }
  if (!PR_ACTIONS.has(p.action)) return ignored(`pull_request.${p.action}`);

  const prior = await d.store.getPrState(full, p.number);
  const headChanged = !prior || prior.latestHeadSha !== headSha;
  if (headChanged) {
    await d.store.setPrState({ repoFullName: full, prNumber: p.number, latestHeadSha: headSha, updatedAt: new Date().toISOString() });
    const stale = await d.store.supersedeJobs(full, p.number, headSha);
    if (stale.length) await d.store.appendAudit({ actor: "guardian", action: "jobs.superseded", repoFullName: full, prNumber: p.number, headSha, details: { jobIds: stale } });
  }
  // `edited` only matters when the base branch changed (the merge candidate changes with it).
  const key = `${full}#${p.number}@${headSha}:pull_request${p.action === "edited" ? `:base-${p.pull_request.base.sha}` : ""}`;
  const { job, created } = await enqueueAndDispatch(d, {
    idempotencyKey: key,
    repoFullName: full,
    installationId: p.installation.id,
    prNumber: p.number,
    baseSha: p.pull_request.base.sha,
    headSha,
    trigger: "pull_request",
    deliveryId,
  });
  await d.store.appendAudit({ actor: "github", action: created ? "job.enqueued" : "job.duplicate", repoFullName: full, prNumber: p.number, headSha, jobId: job.id, details: { event: `pull_request.${p.action}`, baseSha: p.pull_request.base.sha } });
  return ok({ jobId: job.id, created });
}

async function evaluationJob(full: string, prNumber: number, installationId: number, headSha: string, key: string, deliveryId: string, d: WebhookDeps) {
  const prState = await d.store.getPrState(full, prNumber);
  if (!prState || prState.latestHeadSha !== headSha) return undefined; // stale or unknown event
  const latest = (await d.store.listJobs({ repoFullName: full, prNumber, limit: 5 }))[0];
  return enqueueAndDispatch(d, {
    idempotencyKey: `${full}#${prNumber}@${headSha}:eval:${key}`,
    repoFullName: full,
    installationId,
    prNumber,
    baseSha: latest?.baseSha ?? headSha,
    headSha,
    trigger: "evaluate",
    deliveryId,
  });
}

async function onReview(p: z.infer<typeof reviewPayload>, deliveryId: string, d: WebhookDeps): Promise<WebhookResult> {
  if (!(await authorizedRepo(p.repository.full_name, p.installation.id, d))) return ignored("repository is not installed/enabled");
  if (!["submitted", "dismissed", "edited"].includes(p.action)) return ignored(`pull_request_review.${p.action}`);
  const res = await evaluationJob(p.repository.full_name, p.pull_request.number, p.installation.id, p.pull_request.head.sha, `review-${p.review.id}-${p.action}`, deliveryId, d);
  return res ? ok({ jobId: res.job.id, created: res.created }) : ignored("review is for an unknown or outdated head");
}

async function onCheckRun(p: z.infer<typeof checkRunPayload>, deliveryId: string, d: WebhookDeps): Promise<WebhookResult> {
  if (p.action !== "completed" || p.check_run.name === GUARDIAN_CHECK_NAME) return ignored("not a completed external check");
  const full = p.repository.full_name;
  if (!(await authorizedRepo(full, p.installation.id, d))) return ignored("repository is not installed/enabled");
  // Find the PR whose latest head this check ran on (check_run payloads may omit pull_requests for forks).
  const jobs = await d.store.listJobs({ repoFullName: full, limit: 100 });
  const match = jobs.find((j) => j.headSha === p.check_run.head_sha);
  if (!match) return ignored("check is not for a tracked pull request head");
  const res = await evaluationJob(full, match.prNumber, p.installation.id, p.check_run.head_sha, `check-${p.check_run.id}-${p.check_run.conclusion ?? "none"}`, deliveryId, d);
  return res ? ok({ jobId: res.job.id, created: res.created }) : ignored("check is for an outdated head");
}

async function onComment(p: z.infer<typeof commentPayload>, deliveryId: string, d: WebhookDeps): Promise<WebhookResult> {
  if (p.action !== "created" || !p.issue.pull_request) return ignored("not a new PR comment");
  const m = COMMAND.exec((p.comment.body.split("\n")[0] ?? "").trim());
  if (!m) return ignored("no guardian command");
  if (p.comment.user.type === "Bot") return ignored("bot comment");
  const full = p.repository.full_name;
  if (!(await authorizedRepo(full, p.installation.id, d))) return ignored("repository is not installed/enabled");
  const prState = await d.store.getPrState(full, p.issue.number);
  if (!prState) return ignored("pull request not tracked");
  const actor = p.comment.user.login;
  const permission = await d.gatewayFor(p.installation.id).getCollaboratorPermission(full, actor);

  const isFix = m[1]!.startsWith("fix");
  try {
    if (isFix) {
      if (!d.repairEnabled) throw new Error("repair is disabled for this deployment");
      assertRepairActorAuthorized(actor, d.repairAllowedActors ?? [], permission);
    } else if (!["admin", "maintain", "write"].includes(permission)) {
      throw new Error("write access required");
    }
  } catch (e) {
    await d.store.appendAudit({ actor, action: isFix ? "repair.denied" : "rerun.denied", repoFullName: full, prNumber: p.issue.number, headSha: prState.latestHeadSha, details: { reason: safeErrorMessage(e), permission } });
    return ok({ denied: true });
  }

  if (isFix) {
    const findingId = m[2]!;
    const latest = (await d.store.listJobs({ repoFullName: full, prNumber: p.issue.number, limit: 10 })).find((j) => j.headSha === prState.latestHeadSha && j.status === "succeeded");
    const findings = latest ? await d.store.getFindings(latest.id) : [];
    const target = findings.find((f) => f.id === findingId && f.repairable && f.status === "open");
    if (!target) {
      await d.store.appendAudit({ actor, action: "repair.rejected", repoFullName: full, prNumber: p.issue.number, headSha: prState.latestHeadSha, details: { findingId, reason: "finding not found, not open, or not repairable on the current head" } });
      return ok({ rejected: true });
    }
    await d.store.createRepairSession({ repoFullName: full, prNumber: p.issue.number, findingId, sourceHeadSha: prState.latestHeadSha, branch: `guardian/fix-PR-${p.issue.number}`, status: "requested", requestedBy: actor });
    await d.store.appendAudit({ actor, action: "repair.requested", repoFullName: full, prNumber: p.issue.number, headSha: prState.latestHeadSha, details: { findingId } });
  }
  const { job, created } = await enqueueAndDispatch(d, {
    idempotencyKey: `${full}#${p.issue.number}@${prState.latestHeadSha}:${isFix ? "repair" : "manual"}:${p.comment.id}`,
    repoFullName: full,
    installationId: p.installation.id,
    prNumber: p.issue.number,
    baseSha: prState.latestHeadSha,
    headSha: prState.latestHeadSha,
    trigger: isFix ? "repair" : "manual",
    deliveryId,
  });
  return ok({ jobId: job.id, created });
}
