import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { GUARDIAN_CHECK_NAME } from "@/github/checks";
import type { GuardianDeps } from "@/graph/deps";
import { checkConclusionFor, type Decision } from "@/policy/decisions";
import { isTransientError } from "@/errors";
import { safeErrorMessage } from "@/security/secret-redaction";
import type { AnalysisJob } from "@/storage/store";
import { runGuardian } from "./run-guardian";

export interface PipelineDeps {
  guardian: GuardianDeps;
  checkpointer?: BaseCheckpointSaver;
}

export type ProcessResult = { status: "skipped"; reason: string } | { status: "completed"; decision?: string; interrupted: boolean };

/** Show a pending required check immediately, so branch protection cannot be satisfied by a missing check. */
async function markPending(job: AnalysisJob, d: PipelineDeps): Promise<void> {
  const prior = (await d.guardian.store.listJobs({ repoFullName: job.repoFullName, prNumber: job.prNumber, limit: 10 })).find(
    (j) => j.headSha === job.headSha && j.checkRunId,
  );
  const checkRunId = await d.guardian.github.upsertCheckRun({
    repoFullName: job.repoFullName,
    headSha: job.headSha,
    existingId: prior?.checkRunId,
    name: GUARDIAN_CHECK_NAME,
    status: "in_progress",
    title: "Guardian is analysing this revision",
    summary: `Analysis of \`${job.headSha}\` is in progress (job \`${job.id}\`, attempt ${job.attempt}).`,
    detailsUrl: d.guardian.dashboardUrl?.(job.id),
    externalId: job.id,
  });
  await d.guardian.store.updateJob(job.id, { checkRunId });
}

/**
 * One analysis job, end to end. Safe to call repeatedly (Inngest retries, duplicate events, cron re-dispatch):
 * claiming is atomic, terminal jobs are skipped, and every failure path leaves a visible, retryable job.
 */
export async function processAnalysisJob(jobId: string, d: PipelineDeps): Promise<ProcessResult> {
  const { store } = d.guardian;
  const job = await store.getJob(jobId);
  if (!job) return { status: "skipped", reason: "job not found" };
  if (["succeeded", "stale", "cancelled"].includes(job.status)) return { status: "skipped", reason: `job already ${job.status}` };

  const claimed = await store.claimJob(jobId);
  if (!claimed) {
    // Attempts exhausted: the durable runner may still re-deliver. Make sure the required check FAILS rather
    // than staying pending forever (idempotent: it just rewrites the same failed check).
    if (job.status === "failed" && job.attempt >= job.maxAttempts) {
      await failExhaustedJob(jobId, job.error ?? "analysis failed", d);
      return { status: "skipped", reason: "attempts exhausted; required check marked failed" };
    }
    return { status: "skipped", reason: "job is owned by another worker" };
  }

  try {
    await markPending(claimed, d);
    const repairSession =
      claimed.trigger === "repair"
        ? (await store.listRepairSessions({ repoFullName: claimed.repoFullName, prNumber: claimed.prNumber })).find((r) => r.status === "requested" && r.sourceHeadSha === claimed.headSha)
        : undefined;
    const outcome = await runGuardian(
      {
        repoFullName: claimed.repoFullName,
        installationId: claimed.installationId,
        prNumber: claimed.prNumber,
        jobId: claimed.id,
        runId: `${claimed.id}:${claimed.attempt}`,
        trigger: claimed.trigger,
        expectedHeadSha: claimed.headSha,
        repairRequested: Boolean(repairSession),
        repairSessionId: repairSession?.id,
      },
      d.guardian,
      d.checkpointer,
    );
    if (outcome.interrupted) await persistPaused(claimed, outcome.state, d);
    return { status: "completed", decision: outcome.state.decision?.decision, interrupted: outcome.interrupted };
  } catch (err) {
    const message = safeErrorMessage(err);
    await store.updateJob(jobId, { status: "failed", error: message });
    await store.appendAudit({ actor: "guardian", action: isTransientError(err) ? "analysis.retryable_failure" : "analysis.failed", repoFullName: job.repoFullName, prNumber: job.prNumber, headSha: job.headSha, jobId, details: { error: message, attempt: claimed.attempt } });
    throw err; // lets the durable runner apply its retry policy
  }
}

/** A paused graph never reaches finalizeDecision; persist what the dashboard needs. */
async function persistPaused(job: AnalysisJob, state: import("@/graph/state").GuardianStateType, d: PipelineDeps) {
  const decision = state.decision;
  await d.guardian.store.updateJob(job.id, {
    status: "succeeded",
    decision: decision?.decision,
    baseSha: state.baseSha,
    candidateSha: state.candidateSha,
    result: {
      reasons: decision?.reasons ?? [],
      blockingFindingIds: decision?.blockingFindingIds ?? [],
      checks: state.checks,
      filesChanged: state.filesChanged,
      affectedModules: state.impact?.affectedModules ?? [],
      policyVersion: state.policyVersion,
      guardianVersion: d.guardian.guardianVersion,
      workflowStatus: state.workflowStatus,
      approval: decision?.approval ? { needed: true, approvers: decision.approval.approvers, validApprovers: decision.approval.evaluation.validApprovers } : undefined,
    },
  });
  if (decision) await d.guardian.store.saveFindings(job.id, decision.findings);
  await d.guardian.store.appendAudit({ actor: "guardian", action: "analysis.paused", repoFullName: job.repoFullName, prNumber: job.prNumber, headSha: job.headSha, jobId: job.id, details: { decision: decision?.decision, status: state.workflowStatus } });
}

/**
 * Called when the durable runner has exhausted retries. The required check must FAIL (never stay pending
 * or pass), and the failure must be visible on the PR so someone can retry from the dashboard.
 *
 * This can fire late: a user may already have retried (or the sweeper re-queued) the same job. So it only acts on a job
 * that is still `failed`, and after publishing it re-reads the job and restores the stored outcome if it lost a race.
 */
export async function failExhaustedJob(jobId: string, error: string, d: PipelineDeps): Promise<void> {
  const { store, github } = d.guardian;
  const job = await store.getJob(jobId);
  if (!job) return;
  if (job.status !== "failed") return; // retried / re-queued / already succeeded: the live run owns the check now
  const message = safeErrorMessage(new Error(error));
  await store.updateJob(jobId, { status: "failed", error: message });
  let published = false;
  try {
    await github.upsertCheckRun({
      repoFullName: job.repoFullName,
      headSha: job.headSha,
      existingId: job.checkRunId,
      name: GUARDIAN_CHECK_NAME,
      status: "completed",
      conclusion: "failure",
      title: "Guardian could not complete analysis",
      summary: `Analysis of \`${job.headSha}\` failed after ${job.attempt} attempt(s): ${message}

This check fails closed. Retry from the dashboard or push a new commit.`,
      detailsUrl: d.guardian.dashboardUrl?.(job.id),
      externalId: job.id,
    });
    published = true;
  } catch (e) {
    await store.appendAudit({ actor: "guardian", action: "check.publish_failed", repoFullName: job.repoFullName, prNumber: job.prNumber, headSha: job.headSha, jobId, details: { error: safeErrorMessage(e) } });
  }

  // Did a retry start while we were publishing? If it already finished, put its real outcome back.
  const after = await store.getJob(jobId);
  if (published && after && after.status === "succeeded" && after.decision) {
    const outcome = checkConclusionFor(after.decision as Decision);
    const reasons = ((after.result as { reasons?: string[] } | undefined)?.reasons ?? []).map((r) => `- ${r}`).join("\n");
    await github
      .upsertCheckRun({
        repoFullName: after.repoFullName,
        headSha: after.headSha,
        existingId: after.checkRunId ?? job.checkRunId,
        name: GUARDIAN_CHECK_NAME,
        status: outcome.status,
        conclusion: outcome.conclusion,
        title: `${after.decision.replace(/_/g, " ")}`,
        summary: `Restored after a concurrent retry.

${reasons}`,
        detailsUrl: d.guardian.dashboardUrl?.(after.id),
        externalId: after.id,
      })
      .catch(() => undefined);
    await store.appendAudit({ actor: "guardian", action: "check.restored_after_race", repoFullName: after.repoFullName, prNumber: after.prNumber, headSha: after.headSha, jobId });
    return;
  }
  // If GitHub was unreachable the check could not be failed; the sweeper retries until this flag is true.
  if (after?.status === "failed") await store.updateJob(jobId, { result: { failureCheckPublished: published } });
  await store.appendAudit({ actor: "guardian", action: "analysis.exhausted", repoFullName: job.repoFullName, prNumber: job.prNumber, headSha: job.headSha, jobId, details: { error: message, published } });
}
