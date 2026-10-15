import type { RiskPolicy } from "@/config/guardian-config";
import { SEVERITIES, type Finding, type Severity } from "@/reporting/finding-schema";
import { isKnownRule, rule } from "./rules";

const rank = (s: Severity) => SEVERITIES.indexOf(s); // P0 = 0 (most severe)
export const moreSevere = (a: Severity, b: Severity) => (rank(a) <= rank(b) ? a : b);
export const lessSevere = (a: Severity, b: Severity) => (rank(a) >= rank(b) ? a : b);
export const isAtLeast = (s: Severity, threshold: Severity) => rank(s) <= rank(threshold);

const SENSITIVE_CATEGORIES = new Set(["security", "auth", "database-migration"]);

/**
 * Final severity for a finding. Deterministic rule severities are authoritative (plus policy overrides);
 * model-suggested severities are *clamped* by kind and confidence so a model can neither mint a
 * blocker out of speculation nor silently dismiss a severe-but-uncertain concern.
 */
export function classifySeverity(finding: Finding, policy: RiskPolicy): Finding {
  let severity: Severity;

  if (finding.origin === "deterministic" && isKnownRule(finding.ruleId)) {
    const def = rule(finding.ruleId);
    severity = def.severity;
    const override = policy.severityOverrides[finding.ruleId];
    if (override) {
      // Policy may raise severity freely, but never lower P0 or non-waivable (security) rules.
      const protectedRule = def.severity === "P0" || def.waivable === "none" || policy.nonWaivable.ruleIds.includes(finding.ruleId);
      severity = protectedRule ? moreSevere(severity, override) : override;
    }
  } else {
    severity = finding.severity;
    if (finding.origin === "model") {
      const lowConfidence = finding.confidence < policy.confidence.minForBlocking;
      if (finding.kind === "informational") severity = "P3";
      else if (finding.kind === "potential") severity = lessSevere(severity, "P2");
      if (lowConfidence) {
        // Uncertainty about a severe issue triggers review (P2), not a hard block, and is never silently dropped.
        severity = SENSITIVE_CATEGORIES.has(finding.category) && isAtLeast(severity, "P1") ? "P2" : lessSevere(severity, policy.confidence.lowConfidenceCap);
      }
      // A model alone can never establish P0; that needs deterministic evidence.
      if (severity === "P0") severity = "P1";
      const hasIndependentEvidence = finding.evidence.some((e) => e.source !== "model");
      if (!hasIndependentEvidence && isAtLeast(severity, "P1")) severity = "P2";
    }
  }
  return { ...finding, severity };
}

export const isNonWaivable = (finding: Finding, policy: RiskPolicy): boolean => {
  if (finding.severity === "P0") return true;
  if (policy.nonWaivable.categories.includes(finding.category)) return true;
  if (policy.nonWaivable.ruleIds.includes(finding.ruleId)) return true;
  if (isKnownRule(finding.ruleId)) return rule(finding.ruleId).waivable === "none";
  return false;
};
