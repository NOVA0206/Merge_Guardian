import type { Evidence, Finding } from "@/reporting/finding-schema";
import type { RepoSnapshot } from "@/repository/snapshot";

export interface EvidenceCheck {
  valid: boolean;
  reason?: string;
}

/** Evidence is valid if the cited file exists in base or head and any cited snippet/line really appears there. */
export function validateEvidence(e: Evidence, base: RepoSnapshot, head: RepoSnapshot): EvidenceCheck {
  if (e.source === "check-run" || e.source === "test") return { valid: true };
  if (!e.file) return { valid: e.source === "static" || e.source === "graph", reason: e.file ? undefined : "no file cited" };
  const content = head.files.get(e.file) ?? base.files.get(e.file);
  if (content === undefined) return { valid: false, reason: `file ${e.file} not found in base or head` };
  const lines = content.split("\n");
  if (e.line !== undefined && e.line > lines.length) return { valid: false, reason: `line ${e.line} beyond end of ${e.file}` };
  if (e.snippet) {
    const needle = e.snippet.trim().slice(0, 80);
    const haystack = e.line !== undefined ? lines.slice(Math.max(0, e.line - 3), e.line + 2).join("\n") : content;
    if (needle && !haystack.includes(needle)) return { valid: false, reason: `snippet not found in ${e.file}` };
  }
  return { valid: true };
}

/**
 * Enforce spec section 10: findings are only as strong as their verifiable evidence.
 *  - Deterministic findings keep their classification, but invalid evidence entries are dropped.
 *  - Model findings with no valid evidence are demoted to informational at low confidence.
 *  - Model findings claiming "confirmed" must have at least one non-model evidence item.
 */
export function validateFindingEvidence(findings: Finding[], base: RepoSnapshot, head: RepoSnapshot): Finding[] {
  return findings.map((f) => {
    const checked = f.evidence.map((e) => ({ e, r: validateEvidence(e, base, head) }));
    const kept = checked.filter((c) => c.r.valid).map((c) => c.e);
    const dropped = checked.filter((c) => !c.r.valid);
    if (f.origin === "deterministic") return dropped.length ? { ...f, evidence: kept } : f;

    const hasVerifiable = kept.some((e) => e.source !== "model");
    let kind = f.kind;
    let confidence = f.confidence;
    if (kept.length === 0) {
      kind = "informational";
      confidence = Math.min(confidence, 0.3);
    } else if (!hasVerifiable && (kind === "confirmed" || kind === "probable")) {
      kind = "potential";
      confidence = Math.min(confidence, 0.5);
    }
    const note = dropped.length ? ` (${dropped.length} unverifiable evidence item(s) discarded: ${dropped.map((d) => d.r.reason).join("; ")})` : "";
    return { ...f, evidence: kept, kind, confidence, description: f.description + note };
  });
}
