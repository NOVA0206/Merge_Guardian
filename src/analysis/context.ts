import { buildDependencyGraph, type DependencyGraph } from "@/repository/dependency-graph";
import { computeChangeSet, type ChangeSet } from "@/repository/diff-parser";
import { matchesAny, type RepoSnapshot } from "@/repository/snapshot";
import { makeFinding, type Evidence, type Finding, type FindingInput } from "@/reporting/finding-schema";
import { rule, type RuleId } from "@/policy/rules";
import { parseGuardianConfig, type GuardianConfig } from "@/config/guardian-config";

export interface AnalysisContext {
  base: RepoSnapshot;
  head: RepoSnapshot;
  changes: ChangeSet;
  /** TRUSTED config: always loaded from the base revision, never from the PR. */
  config: GuardianConfig;
  /** Config as proposed by the PR, used only to recognise *intentional* architecture changes. */
  proposedConfig?: GuardianConfig;
  baseGraph: DependencyGraph;
  headGraph: DependencyGraph;
}

export function buildContext(base: RepoSnapshot, head: RepoSnapshot, config?: GuardianConfig, changes?: ChangeSet): AnalysisContext {
  const trusted = config ?? parseGuardianConfig((p) => base.files.get(p));
  let proposed: GuardianConfig | undefined;
  try {
    proposed = parseGuardianConfig((p) => head.files.get(p));
    if (proposed.version === trusted.version) proposed = undefined;
  } catch {
    proposed = undefined;
  }
  return {
    base,
    head,
    changes: changes ?? computeChangeSet(base, head),
    config: trusted,
    proposedConfig: proposed,
    baseGraph: buildDependencyGraph(base),
    headGraph: buildDependencyGraph(head),
  };
}

export function moduleOf(path: string, config: GuardianConfig): string | undefined {
  return config.moduleMap.modules.find((m) => matchesAny(path, m.paths))?.name;
}

export function modulesOf(paths: readonly string[], config: GuardianConfig): string[] {
  return [...new Set(paths.map((p) => moduleOf(p, config)).filter((m): m is string => Boolean(m)))].sort();
}

/** Create a finding from the central rule table so severity/category stay policy-controlled. */
export function ruleFinding(
  id: RuleId,
  input: Omit<FindingInput, "category" | "severity" | "ruleId" | "title"> & { title?: string },
  discriminator = "",
): Finding {
  const def = rule(id);
  return makeFinding({ ...input, ruleId: id, category: def.category, severity: def.severity, title: input.title ?? def.title }, discriminator);
}

export function snippetAt(content: string | undefined, line: number): string | undefined {
  const l = content?.split("\n")[line - 1];
  return l === undefined ? undefined : l.trim().slice(0, 200);
}

export function diffEvidence(file: string, detail: string, line?: number, snippet?: string): Evidence {
  return { source: "diff", file, line, snippet, detail };
}
