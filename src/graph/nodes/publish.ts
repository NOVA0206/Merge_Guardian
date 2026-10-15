import { interrupt } from "@langchain/langgraph";
import { GUARDIAN_CHECK_NAME } from "@/github/checks";
import { checkConclusionFor } from "@/policy/decisions";
import { buildReport, checkSummaryLine, type RunMetadata } from "@/reporting/report-builder";
import type { GuardianDeps } from "../deps";
import { dropScope, ensureConfig } from "../deps";
import type { GuardianStateType } from "../state";
import { guarded } from "./helpers";

function metaFor(state: GuardianStateType, deps: GuardianDeps, completed: boolean): RunMetadata {
  return {
    runId: state.runId,
    repo: state.repoFullName,
    prNumber: state.prNumber,
    baseBranch: state.pr?.baseRef,
    baseSha: state.baseSha ?? "unknown",
    headSha: state.expectedHeadSha,
    candidateSha: state.candidateSha,
    guardianVersion: deps.guardianVersion,
    policyVersion: state.policyVersion,
    startedAt: state.startedAt,
    completedAt: completed ? deps.now().toISOString() : undefined,
    filesChanged: state.filesChanged,
    affectedModules: state.impact?.affectedModules ?? [],
    aiStatus: state.aiStatus,
  };
}

/** Previous comment / check-run ids for this PR, so updates replace instead of piling up. */
async function priorIds(deps: GuardianDeps, state: GuardianStateType) {
  const jobs = await deps.store.listJobs({ repoFullName: state.repoFullName, prNumber: state.prNumber, limit: 10 });
  return {
    commentId: state.report.commentId ?? jobs.find((j) => j.reportCommentId)?.reportCommentId,
    checkRunId: state.report.checkRunId ?? jobs.find((j) => j.headSha === state.expectedHeadSha && j.checkRunId)?.checkRunId,
  };
}

export const publishReport = (deps: GuardianDeps) =>
  guarded(
    "publishReport",
    async (state) => {
      const decision = state.decision;
      if (!decision) return {};
      const ids = await priorIds(deps, state);
      const outcome = checkConclusionFor(decision.decision);
      const dashboardUrl = deps.dashboardUrl?.(state.jobId);
      const mandatory = (state.errors.length ? undefined : await ensureConfig(deps, state).catch(() => undefined))?.policy.mandatoryChecks ?? [];

      if (decision.decision === "STALE") {
        // Never overwrite the PR comment with an outdated analysis; only retire the check on the old SHA.
        const checkRunId = await deps.github.upsertCheckRun({
          repoFullName: state.repoFullName,
          headSha: state.expectedHeadSha,
          existingId: ids.checkRunId,
          name: GUARDIAN_CHECK_NAME,
          status: "completed",
          conclusion: "cancelled",
          title: "Superseded by a newer commit",
          summary: decision.reasons.join("\n"),
          externalId: state.jobId,
        });
        return { report: { checkRunId, published: true } };
      }

      const markdown = buildReport({
        meta: metaFor(state, deps, outcome.status === "completed"),
        decision,
        checks: state.checks,
        mandatoryChecks: mandatory,
        selectedTests: state.impact ? Object.values(state.impact.selectedTests).flat() : [],
        newEnvVars: state.impact?.newEnvVars,
        dashboardUrl,
      });
      const commentId = await deps.github.upsertReportComment(state.repoFullName, state.prNumber, markdown, ids.commentId);
      const checkRunId = await deps.github.upsertCheckRun({
        repoFullName: state.repoFullName,
        headSha: state.expectedHeadSha,
        existingId: ids.checkRunId,
        name: GUARDIAN_CHECK_NAME,
        status: outcome.status,
        conclusion: outcome.conclusion,
        title: checkSummaryLine(decision),
        summary: markdown,
        detailsUrl: dashboardUrl,
        externalId: state.jobId,
      });
      await deps.store.updateJob(state.jobId, { checkRunId, reportCommentId: commentId });
      return { report: { checkRunId, commentId, published: true } };
    },
    { runOnError: true },
  );

/**
 * Pause the workflow until a human acts. The checkpointer persists state; resumption is triggered by an
 * authenticated GitHub review webhook, and the approval itself is re-verified from GitHub on resume,
 * so the resume payload carries no authority.
 */
export const requestHumanApproval = (_deps: GuardianDeps) =>
  guarded("requestHumanApproval", async (state) => {
    interrupt({
      type: "approval-required",
      repo: state.repoFullName,
      pr: state.prNumber,
      headSha: state.expectedHeadSha,
      approvers: state.decision?.approval?.approvers ?? [],
      findingIds: state.decision?.approval?.findingIds ?? [],
    });
    return { approvalRounds: state.approvalRounds + 1, workflowStatus: "running" };
  });

export const finalizeDecision = (deps: GuardianDeps) =>
  guarded(
    "finalizeDecision",
    async (state) => {
      const decision = state.decision;
      const published = state.report.published;
      let status: "succeeded" | "failed" | "stale" | "cancelled";
      let error: string | undefined;
      if (state.workflowStatus === "stale") status = "stale";
      else if (state.pr?.state === "closed" && !decision) status = "cancelled";
      else if (decision && !published) {
        status = "failed";
        error = "Result could not be published to GitHub (check run / comment update failed).";
      } else status = "succeeded";

      const errs = state.errors.length ? state.errors : error ? [error] : [];
      await deps.store.updateJob(state.jobId, {
        status,
        decision: decision?.decision,
        error: errs.join("; ").slice(0, 1000) || undefined,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        result: decision
          ? {
              reasons: decision.reasons,
              blockingFindingIds: decision.blockingFindingIds,
              waivedFindingIds: decision.waivedFindingIds,
              failedChecks: decision.failedChecks,
              pendingChecks: decision.pendingChecks,
              checks: state.checks,
              filesChanged: state.filesChanged,
              affectedModules: state.impact?.affectedModules ?? [],
              selectedTests: state.impact?.selectedTests,
              newEnvVars: state.impact?.newEnvVars,
              policyVersion: state.policyVersion,
              guardianVersion: deps.guardianVersion,
              aiStatus: state.aiStatus,
              workflowStatus: state.workflowStatus,
              repair: state.repair,
              approval: decision.approval ? { needed: decision.approval.needed, approvers: decision.approval.approvers, validApprovers: decision.approval.evaluation.validApprovers } : undefined,
            }
          : undefined,
      });
      if (decision) await deps.store.saveFindings(state.jobId, decision.findings);
      await deps.store.appendAudit({
        actor: "guardian",
        action: `analysis.${status}`,
        repoFullName: state.repoFullName,
        prNumber: state.prNumber,
        headSha: state.expectedHeadSha,
        jobId: state.jobId,
        details: { decision: decision?.decision, baseSha: state.baseSha, candidateSha: state.candidateSha, policyVersion: state.policyVersion, guardianVersion: deps.guardianVersion, failedChecks: decision?.failedChecks, pendingChecks: decision?.pendingChecks, errors: errs },
      });
      dropScope(state.runId);
      return {};
    },
    { runOnError: true },
  );
