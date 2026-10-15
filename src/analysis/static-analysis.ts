import type { Finding } from "@/reporting/finding-schema";
import { analyzeArchitecture } from "./architecture-analysis";
import { analyzeApiContracts, analyzeExportCompatibility, analyzeImportResolution, analyzeMigrations } from "./contract-analysis";
import { analyzeDependencies, analyzeEnvironment } from "./config-analysis";
import { analyzeCoverage, analyzeImpact, type ImpactReport } from "./impact-analysis";
import { analyzeAuth, analyzeSecrets, analyzeWorkflows } from "./security-analysis";
import type { AnalysisContext } from "./context";

export interface StaticAnalysisResult {
  findings: Finding[];
  impact: ImpactReport;
}

/** Run every deterministic analyzer. No network, no model: same input always yields the same findings. */
export function runStaticAnalysis(ctx: AnalysisContext): StaticAnalysisResult {
  const impact = analyzeImpact(ctx);
  const findings = [
    ...analyzeArchitecture(ctx),
    ...analyzeApiContracts(ctx),
    ...analyzeExportCompatibility(ctx),
    ...analyzeImportResolution(ctx),
    ...analyzeMigrations(ctx),
    ...analyzeSecrets(ctx),
    ...analyzeWorkflows(ctx),
    ...analyzeAuth(ctx),
    ...analyzeEnvironment(ctx),
    ...analyzeDependencies(ctx),
    ...analyzeCoverage(ctx, impact),
  ];
  // Stable de-duplication by id.
  const byId = new Map<string, Finding>();
  for (const f of findings) if (!byId.has(f.id)) byId.set(f.id, f);
  return { findings: [...byId.values()], impact };
}
