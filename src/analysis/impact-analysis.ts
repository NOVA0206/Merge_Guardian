import { isTestFile } from "@/repository/file-classifier";
import { matchesAny } from "@/repository/snapshot";
import type { Finding } from "@/reporting/finding-schema";
import { diffEvidence, modulesOf, moduleOf, ruleFinding, type AnalysisContext } from "./context";

export interface ImpactReport {
  changedFiles: string[];
  directDependents: string[];
  transitiveDependents: Array<{ file: string; via: string[] }>;
  affectedModules: string[];
  criticalWorkflows: string[];
  /** Test files in the repo that import (directly or transitively) a changed file. */
  impactedTestFiles: string[];
  /** Tests selected from test-matrix.yaml by changed + impacted source files. */
  selectedTests: Record<"unit" | "integration" | "contract" | "database" | "browser" | "smoke", string[]>;
  /** Environment variables newly required by this change. */
  newEnvVars: string[];
  /** Relationships Guardian could not resolve; findings relying on them are lower confidence. */
  uncertainFiles: string[];
}

export function analyzeImpact(ctx: AnalysisContext): ImpactReport {
  const changed = ctx.changes.files.filter((f) => f.status !== "deleted").map((f) => f.path);
  const removed = ctx.changes.files.filter((f) => f.status === "deleted" || f.status === "renamed").map((f) => f.previousPath ?? f.path);
  const direct = new Set<string>();
  for (const f of changed) for (const e of ctx.headGraph.directDependents(f)) direct.add(e.from);
  for (const f of removed) for (const e of ctx.baseGraph.directDependents(f)) if (ctx.head.files.has(e.from)) direct.add(e.from);

  const trans = ctx.headGraph.transitiveDependents(changed);
  const impacted = new Set<string>([...changed, ...trans.keys(), ...direct]);
  const impactedTests = [...impacted].filter(isTestFile);

  const modules = modulesOf([...impacted], ctx.config);
  const criticalWorkflows = ctx.config.architecture.criticalWorkflows
    .filter((w) => [...impacted].some((p) => matchesAny(p, w.paths)))
    .map((w) => w.id);

  const selected = { unit: new Set<string>(), integration: new Set<string>(), contract: new Set<string>(), database: new Set<string>(), browser: new Set<string>(), smoke: new Set<string>() };
  for (const feature of ctx.config.testMatrix.features) {
    if ([...impacted].some((p) => matchesAny(p, feature.sources))) {
      for (const k of Object.keys(selected) as Array<keyof typeof selected>) feature.tests[k].forEach((t) => selected[k].add(t));
    }
  }
  impactedTests.forEach((t) => selected.unit.add(t));

  const baseEnv = new Set([...ctx.baseGraph.facts.values()].flatMap((f) => f.envVars.map((e) => e.name)));
  const newEnv = new Set<string>();
  for (const f of changed) for (const e of ctx.headGraph.facts.get(f)?.envVars ?? []) if (!baseEnv.has(e.name)) newEnv.add(e.name);

  return {
    changedFiles: changed,
    directDependents: [...direct].sort(),
    transitiveDependents: [...trans.entries()].map(([file, via]) => ({ file, via })),
    affectedModules: modules,
    criticalWorkflows,
    impactedTestFiles: impactedTests.sort(),
    selectedTests: Object.fromEntries(Object.entries(selected).map(([k, v]) => [k, [...v].sort()])) as ImpactReport["selectedTests"],
    newEnvVars: [...newEnv].sort(),
    uncertainFiles: [...new Set([...ctx.headGraph.uncertain])].sort(),
  };
}

/** Critical workflows touched without any accompanying test change. */
export function analyzeCoverage(ctx: AnalysisContext, impact: ImpactReport): Finding[] {
  const testsChanged = ctx.changes.files.some((f) => f.kinds.includes("test"));
  if (testsChanged) return [];
  const findings: Finding[] = [];
  const touchedSource = ctx.changes.files.filter((f) => f.kinds.includes("source") && f.status !== "deleted");
  for (const feature of ctx.config.testMatrix.features) {
    if (!feature.critical) continue;
    const hit = touchedSource.filter((f) => matchesAny(f.path, feature.sources));
    if (hit.length === 0) continue;
    findings.push(
      ruleFinding(
        "coverage/critical-without-tests",
        {
          confidence: 0.8,
          kind: "probable",
          description: `Critical feature \`${feature.id}\` changed (${hit.map((h) => h.path).join(", ")}) without adding or updating any test.`,
          evidence: hit.slice(0, 5).map((h) => diffEvidence(h.path, `Matches test-matrix feature \`${feature.id}\` sources; no test files changed in this PR.`)),
          affectedFiles: hit.map((h) => h.path),
          affectedModules: [...new Set(hit.map((h) => moduleOf(h.path, ctx.config)).filter((m): m is string => Boolean(m)))],
          potentialImpact: "A regression in a critical workflow would not be caught by new tests.",
          recommendedFix: `Add or update tests for \`${feature.id}\`: ${Object.values(feature.tests).flat().join(", ") || "none mapped yet"}.`,
          requiredTests: Object.values(feature.tests).flat(),
        },
        feature.id,
      ),
    );
  }
  void impact;
  return findings;
}
