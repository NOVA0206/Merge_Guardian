import ts from "typescript";
import { buildContext, type AnalysisContext } from "@/analysis/context";
import { runStaticAnalysis } from "@/analysis/static-analysis";
import { classifySeverity, isAtLeast } from "@/policy/severity";
import type { Finding } from "@/reporting/finding-schema";
import { assertSafeRepoPath } from "@/security/input-sanitization";
import { isRepairPathForbidden, isTestPath } from "@/security/permissions";
import { VirtualWorkspace, type FileDiffStat, type Patch } from "./isolated-workspace";

export const REPAIR_LIMITS = { maxFiles: 5, maxChangedLines: 120 } as const;

export interface PatchValidation {
  ok: boolean;
  reasons: string[];
  diff: FileDiffStat[];
  /** Findings that remain / newly appear after the patch (for the report). */
  residual: Array<{ id: string; ruleId: string; severity: string }>;
}

function syntaxErrors(path: string, content: string): string | undefined {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return undefined;
  const out = ts.transpileModule(content, { reportDiagnostics: true, fileName: path, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 } });
  const d = out.diagnostics?.[0];
  return d ? ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 160) : undefined;
}

/**
 * Deterministic gate between "a patch was proposed" and "a patch may be published":
 *  - scope: only files implicated by the finding; never policy/CI/secret paths; tests may be added, never weakened;
 *  - hygiene: size limits, valid syntax, no unrelated churn;
 *  - effect: re-running Guardian's own analyzers on the patched tree must remove the targeted finding
 *    and introduce no new P0/P1 finding.
 */
export function validatePatch(patch: Patch, ctx: AnalysisContext, finding: Finding): PatchValidation {
  const reasons: string[] = [];
  const ws = new VirtualWorkspace(ctx.head);
  const diff = ws.diff(patch);

  if (patch.findingId !== finding.id) reasons.push("Patch targets a different finding.");
  if (patch.files.length === 0) reasons.push("Patch is empty.");
  if (patch.files.length > REPAIR_LIMITS.maxFiles) reasons.push(`Patch touches ${patch.files.length} files (limit ${REPAIR_LIMITS.maxFiles}).`);
  const lines = diff.reduce((n, d) => n + d.additions + d.deletions, 0);
  if (lines > REPAIR_LIMITS.maxChangedLines) reasons.push(`Patch changes ${lines} lines (limit ${REPAIR_LIMITS.maxChangedLines}).`);

  const allowed = new Set(finding.affectedFiles);
  for (const f of patch.files) {
    try {
      assertSafeRepoPath(f.path);
    } catch {
      reasons.push(`Unsafe path: ${f.path}`);
      continue;
    }
    const exists = ctx.head.files.has(f.path);
    if (isRepairPathForbidden(f.path)) reasons.push(`Repairs may not modify protected path ${f.path}.`);
    else if (f.content === null) reasons.push(`Repairs may not delete files (${f.path}).`);
    else if (isTestPath(f.path) && exists) reasons.push(`Repairs may add tests but never modify existing ones (${f.path}).`);
    else if (!isTestPath(f.path) && !allowed.has(f.path)) reasons.push(`${f.path} is not implicated by the finding (unrelated change).`);
    else if (f.content !== null) {
      const err = syntaxErrors(f.path, f.content);
      if (err) reasons.push(`Syntax error in ${f.path}: ${err}`);
    }
  }
  if (reasons.length) return { ok: false, reasons, diff, residual: [] };

  // Effect check: analyse base -> patched head with the same trusted configuration.
  const patchedHead = ws.apply(patch);
  const patchedCtx = buildContext(ctx.base, patchedHead, ctx.config);
  const after = runStaticAnalysis(patchedCtx).findings.map((f) => classifySeverity(f, ctx.config.policy));
  const before = new Set(runStaticAnalysis(ctx).findings.map((f) => f.id));
  if (after.some((f) => f.id === finding.id)) reasons.push("The targeted finding is still reported after applying the patch.");
  const introduced = after.filter((f) => !before.has(f.id) && isAtLeast(f.severity, "P1"));
  for (const f of introduced) reasons.push(`Patch introduces a new ${f.severity} finding: ${f.ruleId}.`);

  return { ok: reasons.length === 0, reasons, diff, residual: after.map((f) => ({ id: f.id, ruleId: f.ruleId, severity: f.severity })) };
}
