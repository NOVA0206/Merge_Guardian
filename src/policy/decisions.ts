import type { RiskPolicy } from "@/config/guardian-config";
import type { CheckResult, Finding } from "@/reporting/finding-schema";
import { evaluateApprovals, type ApprovalEvaluation, type ReviewRecord } from "./approval-policy";
import { isKnownRule, rule } from "./rules";
import { classifySeverity, isAtLeast, isNonWaivable } from "./severity";

export const DECISIONS = ["PASS", "PASS_WITH_WARNINGS", "REQUIRES_APPROVAL", "BLOCKED", "PENDING", "STALE", "ERROR"] as const;
export type Decision = (typeof DECISIONS)[number];

export interface PolicyInput {
  findings: readonly Finding[];
  /** Results for the EXACT head SHA being decided. */
  checks: readonly CheckResult[];
  policy: RiskPolicy;
  headSha: string;
  /** Latest head SHA known at decision time; a mismatch makes the result STALE. */
  currentHeadSha?: string;
  reviews: readonly ReviewRecord[];
  prAuthor: string;
  ai: "ok" | "unavailable" | "skipped";
  /** Fatal analysis errors (GitHub/DB failures, invalid config). Any entry yields ERROR. */
  errors?: readonly string[];
  /** True once the grace period for mandatory CI checks has elapsed; missing checks then block. */
  pendingExpired?: boolean;
}

export interface PolicyDecision {
  decision: Decision;
  reasons: string[];
  findings: Finding[];
  blockingFindingIds: string[];
  waivedFindingIds: string[];
  failedChecks: string[];
  pendingChecks: string[];
  approval?: { needed: boolean; approvers: string[]; evaluation: ApprovalEvaluation; findingIds: string[] };
}

const REVIEWABLE_KINDS = new Set(["intentional", "potential", "probable"]);

function canBeWaived(f: Finding, policy: RiskPolicy): boolean {
  if (isNonWaivable(f, policy)) return false;
  if (isKnownRule(f.ruleId) && rule(f.ruleId).waivable !== "architecture") return false;
  // A *confirmed* breakage is fixed, not approved, unless the author flagged an intentional change.
  return f.approvalRequired || REVIEWABLE_KINDS.has(f.kind);
}

/**
 * The single place where a merge decision is made. Pure and deterministic:
 * the same findings, checks, policy, and reviews always produce the same decision.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { policy } = input;
  const reasons: string[] = [];
  const base = { reasons, blockingFindingIds: [] as string[], waivedFindingIds: [] as string[], failedChecks: [] as string[], pendingChecks: [] as string[] };

  const classified = input.findings.map((f) => classifySeverity(f, policy));

  if (input.currentHeadSha && input.currentHeadSha !== input.headSha) {
    reasons.push(`Analysis is for ${input.headSha.slice(0, 7)} but the PR head is now ${input.currentHeadSha.slice(0, 7)}; this result cannot satisfy required checks.`);
    return { ...base, decision: "STALE", findings: classified };
  }
  if (input.errors && input.errors.length > 0) {
    reasons.push(...input.errors.map((e) => `Analysis error: ${e}`));
    return { ...base, decision: "ERROR", findings: classified };
  }
  if (policy.aiRequired && input.ai !== "ok") {
    reasons.push("Policy requires AI analysis, but the AI provider was unavailable.");
    return { ...base, decision: "ERROR", findings: classified };
  }

  // 1. Mandatory checks: absence is never success.
  for (const name of policy.mandatoryChecks) {
    const r = input.checks.find((c) => c.name === name);
    const forThisSha = r && (!r.headSha || r.headSha === input.headSha);
    if (!r || !forThisSha || r.status === "NOT_RUN") base.pendingChecks.push(name);
    else if (r.status === "PENDING") base.pendingChecks.push(name);
    else if (r.status === "FAIL") base.failedChecks.push(name);
  }

  // 2. Approvals (only meaningful for waivable findings).
  const open = classified.filter((f) => f.status === "open");
  const waivable = open.filter((f) => canBeWaived(f, policy));
  const needsReviewers = waivable.filter((f) => isAtLeast(f.severity, "P1") || f.approvalRequired || (f.severity === "P2" && policy.mediumRequiresReview));
  const approvers = [...new Set([...policy.approval.architectureApprovers])];
  const evaluation = evaluateApprovals({ reviews: input.reviews, headSha: input.headSha, approvers, required: policy.approval.requiredApprovals, prAuthor: input.prAuthor });

  const waivedIds = new Set<string>();
  if (evaluation.satisfied) for (const f of needsReviewers) waivedIds.add(f.id);
  const findings = classified.map((f) => (waivedIds.has(f.id) ? { ...f, status: "waived" as const } : f));
  base.waivedFindingIds = [...waivedIds];

  const stillOpen = findings.filter((f) => f.status === "open");
  const hardBlockers = stillOpen.filter((f) => policy.blockingSeverities.includes(f.severity) && !canBeWaived(f, policy));
  const approvalBlockers = stillOpen.filter((f) => policy.blockingSeverities.includes(f.severity) && canBeWaived(f, policy));
  const reviewOnly = stillOpen.filter((f) => f.severity === "P2" && policy.mediumRequiresReview && canBeWaived(f, policy) && !approvalBlockers.includes(f));

  // 3. Decide, most restrictive first.
  if (base.failedChecks.length > 0) reasons.push(`Mandatory check(s) failed: ${base.failedChecks.join(", ")}.`);
  for (const f of hardBlockers) reasons.push(`${f.severity} ${f.title}: ${f.affectedFiles.slice(0, 3).join(", ")} (${f.ruleId}${isNonWaivable(f, policy) ? ", not waivable" : ""}).`);
  base.blockingFindingIds = hardBlockers.map((f) => f.id);

  if (base.failedChecks.length > 0 || hardBlockers.length > 0) return { ...base, decision: "BLOCKED", findings };

  if (base.pendingChecks.length > 0) {
    const detail = `Mandatory check(s) not completed on ${input.headSha.slice(0, 7)}: ${base.pendingChecks.join(", ")}.`;
    reasons.push(detail);
    return { ...base, decision: input.pendingExpired ? "BLOCKED" : "PENDING", findings };
  }

  if (approvalBlockers.length > 0 || reviewOnly.length > 0) {
    const ids = [...approvalBlockers, ...reviewOnly].map((f) => f.id);
    base.blockingFindingIds = ids;
    if (evaluation.configurationMissing) reasons.push("Approval is required but no `approval.architectureApprovers` are configured in risk-policy.yaml; the change cannot be approved until they are.");
    else reasons.push(`Approval from a designated approver (${approvers.join(", ")}) on ${input.headSha.slice(0, 7)} is required for: ${[...approvalBlockers, ...reviewOnly].map((f) => f.title).join("; ")}.`);
    for (const r of evaluation.rejected) reasons.push(`Ignored review by ${r.user}: ${r.reason}.`);
    return { ...base, decision: "REQUIRES_APPROVAL", findings, approval: { needed: true, approvers, evaluation, findingIds: ids } };
  }

  const warnings = findings.filter((f) => f.status === "waived" || (f.status === "open" && f.kind !== "informational"));
  if (warnings.length > 0) {
    reasons.push(`No blocking issues. ${warnings.length} warning(s) remain for reviewer attention.`);
    return { ...base, decision: "PASS_WITH_WARNINGS", findings, approval: waivedIds.size ? { needed: false, approvers, evaluation, findingIds: [...waivedIds] } : undefined };
  }
  reasons.push("All mandatory checks passed and no findings require action.");
  return { ...base, decision: "PASS", findings };
}

/** GitHub check-run mapping. Only success may satisfy a required status check. */
export function checkConclusionFor(decision: Decision): { status: "completed" | "in_progress"; conclusion?: "success" | "failure" | "action_required" | "cancelled" } {
  switch (decision) {
    case "PASS":
    case "PASS_WITH_WARNINGS":
      return { status: "completed", conclusion: "success" };
    case "REQUIRES_APPROVAL":
      return { status: "completed", conclusion: "action_required" };
    case "BLOCKED":
    case "ERROR":
      return { status: "completed", conclusion: "failure" };
    case "STALE":
      return { status: "completed", conclusion: "cancelled" };
    case "PENDING":
      return { status: "in_progress" };
  }
}
