import path from "node:path";
import { buildContext } from "@/analysis/context";
import { runStaticAnalysis } from "@/analysis/static-analysis";
import { evaluatePolicy, type PolicyDecision } from "@/policy/decisions";
import type { ReviewRecord } from "@/policy/approval-policy";
import type { CheckResult } from "@/reporting/finding-schema";
import { snapshotFromDirectory, snapshotFromMap, type RepoSnapshot } from "@/repository/snapshot";

export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);

let cached: RepoSnapshot | undefined;
export function baseApp(): RepoSnapshot {
  cached ??= snapshotFromDirectory(BASE_SHA, path.resolve(__dirname, "../fixtures/app-base"));
  return cached;
}

/** Apply file changes on top of a snapshot. `null` deletes a file. */
export function overlay(base: RepoSnapshot, changes: Record<string, string | null>, sha = HEAD_SHA): RepoSnapshot {
  const files = new Map(base.files);
  for (const [p, c] of Object.entries(changes)) {
    if (c === null) files.delete(p);
    else files.set(p, c);
  }
  return snapshotFromMap(sha, files);
}

export const passingChecks = (sha = HEAD_SHA): CheckResult[] =>
  ["lint", "typecheck", "unit-tests", "build"].map((name) => ({ name, status: "PASS", headSha: sha }));

export function analyze(
  head: RepoSnapshot,
  opts: { base?: RepoSnapshot; checks?: CheckResult[]; reviews?: ReviewRecord[]; author?: string; currentHeadSha?: string } = {},
): PolicyDecision & { impact: ReturnType<typeof runStaticAnalysis>["impact"] } {
  const base = opts.base ?? baseApp();
  const ctx = buildContext(base, head);
  const { findings, impact } = runStaticAnalysis(ctx);
  const decision = evaluatePolicy({
    findings,
    checks: opts.checks ?? passingChecks(head.sha),
    policy: ctx.config.policy,
    headSha: head.sha,
    currentHeadSha: opts.currentHeadSha,
    reviews: opts.reviews ?? [],
    prAuthor: opts.author ?? "dev-one",
    ai: "skipped",
  });
  return { ...decision, impact };
}

export const ruleIds = (d: PolicyDecision) => d.findings.map((f) => f.ruleId);
