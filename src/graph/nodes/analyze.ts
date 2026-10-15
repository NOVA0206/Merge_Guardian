import { analyzeApiContracts, analyzeExportCompatibility, analyzeImportResolution, analyzeMigrations } from "@/analysis/contract-analysis";
import { analyzeDependencies, analyzeEnvironment } from "@/analysis/config-analysis";
import { analyzeArchitecture as runArchitectureRules } from "@/analysis/architecture-analysis";
import { ruleFinding } from "@/analysis/context";
import { analyzeCoverage } from "@/analysis/impact-analysis";
import { buildReviewPrompt, modelFindingsToFindings } from "@/analysis/semantic-review";
import { analyzeAuth, analyzeSecrets, analyzeWorkflows } from "@/analysis/security-analysis";
import { safeErrorMessage } from "@/security/secret-redaction";
import type { GuardianDeps } from "../deps";
import { getScope } from "../deps";
import { guarded } from "./helpers";

/** Deterministic checks that don't fit a narrower node: environment, dependencies, coverage, merge state. */
export const runStaticAnalysis = (_deps: GuardianDeps) =>
  guarded("runStaticAnalysis", async (state) => {
    const ctx = getScope(state.runId).ctx;
    if (!ctx || !state.impact) return {};
    const findings = [...analyzeEnvironment(ctx), ...analyzeDependencies(ctx), ...analyzeCoverage(ctx, state.impact)];
    if (state.mergeConflict) {
      findings.push(
        ruleFinding("integration/merge-conflict", {
          confidence: 1,
          kind: "confirmed",
          description: `GitHub reports that PR #${state.prNumber} cannot be merged cleanly into \`${state.pr?.baseRef}\`.`,
          evidence: [{ source: "check-run", detail: "GitHub mergeable=false for the current head." }],
          affectedFiles: [],
          affectedModules: [],
          potentialImpact: "The combined result cannot be built or tested until conflicts are resolved; individual passing checks are meaningless.",
          recommendedFix: `Merge or rebase \`${state.pr?.baseRef}\` into the branch and resolve conflicts.`,
          requiredTests: [],
        }),
      );
    }
    return { rawFindings: findings };
  });

export const analyzeContracts = (_deps: GuardianDeps) =>
  guarded("analyzeContracts", async (state) => {
    const ctx = getScope(state.runId).ctx;
    if (!ctx) return {};
    return { rawFindings: [...analyzeApiContracts(ctx), ...analyzeExportCompatibility(ctx), ...analyzeImportResolution(ctx), ...analyzeMigrations(ctx)] };
  });

export const analyzeArchitecture = (_deps: GuardianDeps) =>
  guarded("analyzeArchitecture", async (state) => {
    const ctx = getScope(state.runId).ctx;
    return ctx ? { rawFindings: runArchitectureRules(ctx) } : {};
  });

export const analyzeSecurity = (_deps: GuardianDeps) =>
  guarded("analyzeSecurity", async (state) => {
    const ctx = getScope(state.runId).ctx;
    return ctx ? { rawFindings: [...analyzeSecrets(ctx), ...analyzeWorkflows(ctx), ...analyzeAuth(ctx)] } : {};
  });

/**
 * Model-assisted semantic review. Advisory: any failure degrades to aiStatus "unavailable"
 * (deterministic gates still run; policy.aiRequired turns that into ERROR).
 */
export const semanticReview = (deps: GuardianDeps) =>
  guarded("semanticReview", async (state) => {
    const ctx = getScope(state.runId).ctx;
    if (!ctx || !state.impact) return {};
    if (!deps.reviewer) return { aiStatus: "skipped" };
    try {
      const prompt = buildReviewPrompt(ctx, state.impact, state.rawFindings);
      const out = await deps.reviewer.review({ title: state.pr?.title ?? "", description: state.pr?.body ?? "", prompt });
      return { aiStatus: "ok", rawFindings: modelFindingsToFindings(out) };
    } catch (err) {
      // Includes schema-validation failures of model output: never trust malformed structured output.
      console.warn("semanticReview unavailable:", safeErrorMessage(err));
      return { aiStatus: "unavailable" };
    }
  });
