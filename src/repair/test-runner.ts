import type { AnalysisContext } from "@/analysis/context";
import type { Finding } from "@/reporting/finding-schema";
import { isRepairPathForbidden } from "@/security/permissions";

/**
 * Repairs never execute code inside Guardian. Verification happens in isolated GitHub Actions on the
 * repair pull request (no secrets, no write token). This module only decides WHAT must be verified.
 */
export function planRepairTests(finding: Finding, ctx: AnalysisContext): string[] {
  const tests = new Set<string>(["lint", "typecheck", "unit-tests", "build"]);
  for (const t of ctx.config.policy.mandatoryChecks) tests.add(t);
  for (const t of finding.requiredTests) tests.add(t);
  return [...tests];
}

/** CLI-side scope check used by guardian-repair.yml on `guardian/fix-*` branches. */
export function verifyRepairScope(changedPaths: readonly string[], opts: { maxFiles?: number } = {}): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const p of changedPaths) if (isRepairPathForbidden(p)) violations.push(`forbidden path modified: ${p}`);
  if (changedPaths.length > (opts.maxFiles ?? 8)) violations.push(`too many files changed (${changedPaths.length})`);
  return { ok: violations.length === 0, violations };
}
