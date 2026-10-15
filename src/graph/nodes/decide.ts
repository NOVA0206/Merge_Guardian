import { validateFindingEvidence } from "@/analysis/evidence-validator";
import { evaluatePolicy as evaluate } from "@/policy/decisions";
import { classifySeverity } from "@/policy/severity";
import type { Finding } from "@/reporting/finding-schema";
import type { GuardianDeps } from "../deps";
import { ensureConfig, getScope } from "../deps";
import { guarded } from "./helpers";
import type { RiskPolicy } from "@/config/guardian-config";

export const mergeFindings = (_deps: GuardianDeps) =>
  guarded("mergeFindings", async (state) => {
    const byId = new Map<string, Finding>();
    for (const f of state.rawFindings) if (!byId.has(f.id)) byId.set(f.id, f);
    return { findings: [...byId.values()] };
  });

export const validateEvidence = (_deps: GuardianDeps) =>
  guarded("validateEvidence", async (state) => {
    const scope = getScope(state.runId);
    if (!scope.base || !scope.head) return {};
    return { findings: validateFindingEvidence(state.findings, scope.base, scope.head) };
  });

/** Until a human has reviewed the discovered baseline, structural rules are advisory (spec section 6). */
export function effectivePolicy(policy: RiskPolicy, baselineReviewed: boolean): RiskPolicy {
  if (baselineReviewed) return policy;
  return {
    ...policy,
    severityOverrides: { ...policy.severityOverrides, "arch/module-boundary": "P2", "arch/public-interface": "P2", "arch/layer-violation": "P2" },
  };
}

export const classifySeverityNode = (deps: GuardianDeps) =>
  guarded("classifySeverity", async (state) => {
    const config = await ensureConfig(deps, state);
    if (!config) return {};
    const policy = effectivePolicy(config.policy, state.baselineReviewed);
    return { findings: state.findings.map((f) => classifySeverity(f, policy)) };
  });

/** Pull the facts that policy depends on, fresh from GitHub for the exact head SHA. */
export const collectVerification = (deps: GuardianDeps) =>
  guarded("collectVerification", async (state) => {
    const [checks, reviews, prState] = await Promise.all([
      deps.github.listCheckResults(state.repoFullName, state.expectedHeadSha),
      deps.github.listReviews(state.repoFullName, state.prNumber),
      deps.store.getPrState(state.repoFullName, state.prNumber),
    ]);
    const grace = deps.pendingGraceMs ?? 45 * 60_000;
    const seen = prState && prState.latestHeadSha === state.expectedHeadSha ? Date.parse(prState.updatedAt) : deps.now().getTime();
    return { checks, reviews, pendingExpired: deps.now().getTime() - seen > grace };
  });

export const evaluatePolicy = (deps: GuardianDeps) =>
  guarded(
    "evaluatePolicy",
    async (state) => {
      if (state.workflowStatus === "stale") {
        // No config may be available (we stopped early); build a minimal stale decision.
        return {
          decision: { decision: "STALE" as const, reasons: [`Result is for ${state.expectedHeadSha.slice(0, 7)} but the PR head has moved; it cannot satisfy required checks.`], findings: [], blockingFindingIds: [], waivedFindingIds: [], failedChecks: [], pendingChecks: [] },
        };
      }
      // Fail closed: a config that cannot be loaded must still yield a decision (ERROR), never an exception.
      const config = state.errors.length ? undefined : await ensureConfig(deps, state).catch(() => undefined);
      const prState = await deps.store.getPrState(state.repoFullName, state.prNumber);
      const current = prState?.latestHeadSha ?? state.pr?.headSha;
      const policy = config ? effectivePolicy(config.policy, state.baselineReviewed) : undefined;
      const decision = evaluate({
        findings: state.findings,
        checks: state.checks,
        policy: policy ?? ({ blockingSeverities: ["P0", "P1"], mediumRequiresReview: false, mandatoryChecks: [], nonWaivable: { categories: ["security", "auth"], ruleIds: [] }, severityOverrides: {}, confidence: { minForBlocking: 0.7, lowConfidenceCap: "P3" }, approval: { architectureApprovers: [], securityApprovers: [], requiredApprovals: 1 }, aiRequired: true, version: 1 } as RiskPolicy),
        headSha: state.expectedHeadSha,
        currentHeadSha: current,
        reviews: state.reviews,
        prAuthor: state.pr?.author ?? "",
        ai: state.aiStatus,
        errors: state.errors,
        pendingExpired: state.pendingExpired,
      });
      if (!state.baselineReviewed && config && !state.errors.length) {
        decision.reasons.push("Architecture baseline is not yet marked `reviewed: true`; module-boundary rules are advisory until a human approves the baseline.");
      }
      const status = decision.decision === "STALE" ? "stale" : decision.decision === "PENDING" ? "awaiting_checks" : decision.decision === "REQUIRES_APPROVAL" ? "awaiting_approval" : decision.decision === "ERROR" ? "error" : "complete";
      return { decision, findings: decision.findings, workflowStatus: status };
    },
    { runOnError: true },
  );
