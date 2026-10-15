import type { GuardianStateType } from "../state";

/** PR closed (nothing to evaluate) skips straight to finalization; stale/errored runs still flow through policy so they fail closed. */
export function afterLoadPullRequest(state: GuardianStateType): "loadArchitectureBaseline" | "evaluatePolicy" | "finalizeDecision" {
  if (state.workflowStatus === "stale") return "evaluatePolicy";
  if (state.workflowStatus === "complete") return "finalizeDecision"; // closed PR
  if (state.errors.length > 0) return "evaluatePolicy";
  return "loadArchitectureBaseline";
}

/** After a report is published, decide whether a human or the repair engine takes over. */
export function afterPublishReport(state: GuardianStateType): "requestHumanApproval" | "prepareRepair" | "finalizeDecision" {
  const d = state.decision?.decision;
  if (d === "REQUIRES_APPROVAL" && state.report.published) return "requestHumanApproval";
  if (d === "BLOCKED" && state.repair.requested && state.repair.status === "none") return "prepareRepair";
  return "finalizeDecision";
}

export function afterValidateRepair(state: GuardianStateType): "waitForUpdatedCommit" | "finalizeDecision" {
  return state.repair.status === "proposed" ? "waitForUpdatedCommit" : "finalizeDecision";
}
