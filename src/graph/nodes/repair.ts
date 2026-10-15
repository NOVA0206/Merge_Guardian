import { interrupt } from "@langchain/langgraph";
import type { GuardianDeps } from "../deps";
import { ensureContext } from "../deps";
import { guarded } from "./helpers";

/** Hard cap on automated repair attempts per PR head (spec section 13). */
export const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Generate and validate a patch in isolation, then publish it on a guardian/ branch. This node only
 * runs when a write-authorized human explicitly requested a repair (session created by the webhook handler).
 */
export const prepareRepair = (deps: GuardianDeps) =>
  guarded("prepareRepair", async (state) => {
    if (!deps.repair) return { repair: { ...state.repair, status: "unavailable" as const, detail: "Repair is not enabled for this deployment." } };
    if (state.repair.attempts >= MAX_REPAIR_ATTEMPTS) return { repair: { ...state.repair, status: "failed" as const, detail: "Repair attempt limit reached; human intervention required." } };
    const ctx = await ensureContext(deps, state);
    const sessionId = state.repair.sessionId;
    const session = sessionId ? await deps.store.getRepairSession(sessionId) : undefined;
    if (!ctx || !session || session.sourceHeadSha !== state.expectedHeadSha) {
      return { repair: { ...state.repair, status: "failed" as const, detail: "Repair session missing or bound to a different commit." } };
    }
    const result = await deps.repair({
      repoFullName: state.repoFullName,
      prNumber: state.prNumber,
      installationId: state.installationId,
      findingId: session.findingId,
      sourceHeadSha: state.expectedHeadSha,
      requestedBy: session.requestedBy,
      ctx,
      findings: state.findings,
    });
    return { repair: { ...state.repair, attempts: state.repair.attempts + 1, status: result.status, branch: result.branch, repairPrNumber: result.repairPrNumber, detail: result.detail } };
  });

/** A repair only counts if the engine reported fresh validation; a failure is reported honestly and stops. */
export const validateRepair = (deps: GuardianDeps) =>
  guarded("validateRepair", async (state) => {
    const id = state.repair.sessionId;
    const session = id ? await deps.store.getRepairSession(id) : undefined;
    if (state.repair.status === "proposed" && session?.status === "proposed") return {};
    return { repair: { ...state.repair, status: "failed" as const, detail: state.repair.detail ?? "Repair was not validated." } };
  });

export const waitForUpdatedCommit = (_deps: GuardianDeps) =>
  guarded("waitForUpdatedCommit", async (state) => {
    interrupt({ type: "await-updated-commit", repo: state.repoFullName, pr: state.prNumber, repairBranch: state.repair.branch, repairPr: state.repair.repairPrNumber });
    return { workflowStatus: "running" };
  });

export const rerunAnalysis = (deps: GuardianDeps) =>
  guarded("rerunAnalysis", async (state) => {
    const pr = await deps.github.getPullRequest(state.repoFullName, state.prNumber);
    if (pr.headSha === state.expectedHeadSha) return {}; // nothing new was pushed; do not loop
    await deps.enqueue?.({
      idempotencyKey: `${state.repoFullName}#${state.prNumber}@${pr.headSha}:pull_request`,
      repoFullName: state.repoFullName,
      installationId: state.installationId,
      prNumber: state.prNumber,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      trigger: "retry",
    });
    return {};
  });
