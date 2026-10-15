import { matchesAny, matchesGlob } from "@/repository/snapshot";
import type { GuardianConfig } from "@/config/guardian-config";
import type { Finding } from "@/reporting/finding-schema";
import { diffEvidence, moduleOf, modulesOf, ruleFinding, type AnalysisContext } from "./context";
import type { DependencyEdge } from "@/repository/dependency-graph";
import { parseGuardianConfig } from "@/config/guardian-config";

const edgeKey = (e: DependencyEdge) => `${e.from}->${e.to}`;

interface Violation {
  ruleId: "arch/module-boundary" | "arch/public-interface" | "arch/forbidden-import" | "arch/layer-violation";
  reason: string;
  /** Reference to the config entry that was violated. */
  ref: string;
}

/** Evaluate one import edge against a config. Pure; used for both trusted and proposed configs. */
export function edgeViolations(e: DependencyEdge, config: GuardianConfig): Violation[] {
  const out: Violation[] = [];
  const a = moduleOf(e.from, config);
  const b = moduleOf(e.to, config);
  if (a && b && a !== b) {
    const from = config.moduleMap.modules.find((m) => m.name === a)!;
    const to = config.moduleMap.modules.find((m) => m.name === b)!;
    if (!from.dependsOn.includes(b)) {
      out.push({ ruleId: "arch/module-boundary", reason: `Module \`${a}\` is not allowed to depend on \`${b}\` (module-map.yaml dependsOn: [${from.dependsOn.join(", ")}]).`, ref: `${a}->${b}` });
    } else if (to.publicInterface.length > 0 && !matchesAny(e.to, to.publicInterface)) {
      out.push({ ruleId: "arch/public-interface", reason: `\`${e.to}\` is not part of module \`${b}\`'s public interface.`, ref: `${a}->${b}:${e.to}` });
    }
  }
  for (const d of config.architecture.protectedDecisions) {
    const fi = d.forbiddenImport;
    if (fi && matchesGlob(e.from, fi.from) && matchesGlob(e.to, fi.to)) {
      out.push({ ruleId: "arch/forbidden-import", reason: `Protected decision \`${d.id}\`: ${d.description}`, ref: d.id });
    }
  }
  const layers = config.architecture.layers;
  const la = layers.find((l) => matchesAny(e.from, l.paths));
  const lb = layers.find((l) => matchesAny(e.to, l.paths));
  if (la && lb && la.name !== lb.name && !la.mayDependOn.includes(lb.name)) {
    out.push({ ruleId: "arch/layer-violation", reason: `Layer \`${la.name}\` may not depend on layer \`${lb.name}\`.`, ref: `${la.name}->${lb.name}` });
  }
  return out;
}

export function analyzeArchitecture(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const baseEdges = new Set(ctx.baseGraph.edges.map(edgeKey));

  // Only edges introduced by this change: pre-existing violations are not this PR's fault.
  for (const e of ctx.headGraph.edges) {
    if (baseEdges.has(edgeKey(e))) continue;
    const violations = edgeViolations(e, ctx.config);
    for (const v of violations) {
      // Intentional if the PR's own proposed config makes the edge legal (it also edits .guardian/, flagged separately).
      const stillViolatesProposed = ctx.proposedConfig ? edgeViolations(e, ctx.proposedConfig).some((p) => p.ruleId === v.ruleId && p.ref === v.ref) : true;
      const intentional = !stillViolatesProposed;
      const mods = modulesOf([e.from, e.to], ctx.config);
      findings.push(
        ruleFinding(
          v.ruleId,
          {
            confidence: 0.95,
            kind: intentional ? "intentional" : "confirmed",
            description: `${e.from} imports ${e.to}. ${v.reason}`,
            evidence: [
              { source: "graph", file: e.from, detail: `New import edge ${e.from} -> ${e.to} (names: ${e.names.join(", ") || "side-effect"}).` },
              ...(intentional ? [{ source: "diff" as const, file: ".guardian/module-map.yaml", detail: "The PR also modifies Guardian architecture configuration to allow this dependency." }] : []),
            ],
            affectedFiles: [e.from, e.to],
            affectedModules: mods,
            potentialImpact: "Dependency direction diverges from the reviewed architecture, risking circular or hidden coupling between modules.",
            recommendedFix: intentional
              ? "Document the migration and rollback plan in the PR and obtain approval from a designated architecture approver."
              : "Route the dependency through the module's public interface, move the shared code to an allowed module, or propose an architecture change with approval.",
            requiredTests: [],
            approvalRequired: intentional,
          },
          `${v.ref}`,
        ),
      );
    }
  }

  // Changes to protected architectural paths always need an architecture approver.
  for (const decision of ctx.config.architecture.protectedDecisions) {
    if (decision.protectedPaths.length === 0) continue;
    const touched = ctx.changes.files.filter((f) => matchesAny(f.path, decision.protectedPaths) || (f.previousPath && matchesAny(f.previousPath, decision.protectedPaths)));
    if (touched.length === 0) continue;
    findings.push(
      ruleFinding(
        "arch/protected-path-changed",
        {
          confidence: 1,
          kind: "intentional",
          description: `Protected decision \`${decision.id}\` (${decision.description}) covers ${touched.length} changed file(s).`,
          evidence: touched.slice(0, 10).map((f) => diffEvidence(f.path, `${f.status}: matches protected paths of \`${decision.id}\`.`)),
          affectedFiles: touched.map((f) => f.path),
          affectedModules: modulesOf(touched.map((f) => f.path), ctx.config),
          potentialImpact: "Guardian policy, CI enforcement or another protected architectural decision is being changed by the same PR it governs.",
          recommendedFix: "Have a designated approver review these changes at the current head commit.",
          requiredTests: [],
          approvalRequired: true,
        },
        decision.id,
      ),
    );
  }

  // A PR that breaks Guardian's own configuration would otherwise disable enforcement after merge.
  if (ctx.changes.files.some((f) => f.kinds.includes("guardian-policy"))) {
    try {
      parseGuardianConfig((p) => ctx.head.files.get(p));
    } catch (e) {
      findings.push(
        ruleFinding(
          "policy/config-invalid",
          {
            confidence: 1,
            kind: "confirmed",
            description: `The proposed .guardian configuration does not validate: ${(e as Error).message.slice(0, 300)}`,
            evidence: [diffEvidence(".guardian", "Configuration fails schema validation at the PR head.")],
            affectedFiles: ctx.changes.files.filter((f) => f.kinds.includes("guardian-policy")).map((f) => f.path),
            affectedModules: [],
            potentialImpact: "After merge Guardian would fail closed (ERROR) on every PR.",
            recommendedFix: "Fix the YAML so it passes schema validation.",
            requiredTests: [],
          },
          "config",
        ),
      );
    }
  }
  return findings;
}
