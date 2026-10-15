import type { Category, Severity } from "@/reporting/finding-schema";

export interface RuleDefinition {
  category: Category;
  /** Default severity before policy overrides. */
  severity: Severity;
  /**
   * `architecture`: an authorized human approval for the exact head SHA may waive it.
   * `none`: nothing may waive it (security, secrets, failing mandatory checks).
   */
  waivable: "architecture" | "none";
  title: string;
}

/**
 * Central, deterministic rule catalogue. Analyzers reference rules by id; severities come from here
 * (plus `risk-policy.yaml` overrides), never from model output.
 */
export const RULES = {
  "arch/module-boundary": { category: "architecture-drift", severity: "P1", waivable: "architecture", title: "Module boundary violated" },
  "arch/public-interface": { category: "architecture-drift", severity: "P1", waivable: "architecture", title: "Module public interface bypassed" },
  "arch/forbidden-import": { category: "architecture-drift", severity: "P1", waivable: "architecture", title: "Protected architectural decision violated" },
  "arch/layer-violation": { category: "architecture-drift", severity: "P1", waivable: "architecture", title: "Layer dependency rule violated" },
  "arch/protected-path-changed": { category: "architecture-drift", severity: "P1", waivable: "architecture", title: "Protected architecture file changed" },
  "policy/config-invalid": { category: "architecture-drift", severity: "P1", waivable: "none", title: "Guardian configuration is invalid" },
  "contract/api-field-removed": { category: "api-contract", severity: "P1", waivable: "architecture", title: "API response field removed or renamed" },
  "contract/api-field-removed-unconsumed": { category: "api-contract", severity: "P2", waivable: "architecture", title: "API response field removed (no in-repo consumer found)" },
  "contract/api-route-removed": { category: "api-contract", severity: "P1", waivable: "architecture", title: "API route removed while consumers remain" },
  "integration/removed-export": { category: "integration-conflict", severity: "P1", waivable: "none", title: "Export removed but still imported" },
  "integration/removed-module": { category: "integration-conflict", severity: "P1", waivable: "none", title: "Module removed but still imported" },
  "integration/unresolved-import": { category: "integration-conflict", severity: "P1", waivable: "none", title: "Import does not resolve to an existing module or export" },
  "integration/merge-conflict": { category: "integration-conflict", severity: "P1", waivable: "none", title: "Pull request does not merge cleanly into the target branch" },
  "migration/column-dropped-in-use": { category: "database-migration", severity: "P1", waivable: "none", title: "Migration removes schema still used by code" },
  "migration/destructive-data-op": { category: "database-migration", severity: "P0", waivable: "none", title: "Destructive data operation in migration" },
  "migration/schema-breaking": { category: "database-migration", severity: "P2", waivable: "architecture", title: "Potentially backward-incompatible schema change" },
  "dependency/missing-package": { category: "dependency", severity: "P1", waivable: "none", title: "Package imported but not declared" },
  "dependency/major-bump": { category: "dependency", severity: "P2", waivable: "architecture", title: "Major dependency version bump" },
  "dependency/lockfile-not-updated": { category: "dependency", severity: "P2", waivable: "architecture", title: "package.json changed without lockfile update" },
  "security/secret-exposure": { category: "security", severity: "P0", waivable: "none", title: "Credential committed to repository" },
  "security/env-file-committed": { category: "security", severity: "P0", waivable: "none", title: "Environment file with values committed" },
  "security/pull-request-target": { category: "security", severity: "P1", waivable: "none", title: "Privileged workflow executes untrusted PR code" },
  "security/workflow-permissions": { category: "security", severity: "P1", waivable: "none", title: "Workflow requests excessive permissions" },
  "security/unpinned-action": { category: "security", severity: "P3", waivable: "architecture", title: "Third-party action not pinned to a commit SHA" },
  "env/undeclared-variable": { category: "environment", severity: "P2", waivable: "architecture", title: "Environment variable used but not declared" },
  "env/server-var-in-client": { category: "deployment-runtime", severity: "P1", waivable: "none", title: "Server-only variable read in client component" },
  "env/public-secret-name": { category: "security", severity: "P1", waivable: "none", title: "Secret-like variable exposed to the browser" },
  "auth/check-removed": { category: "auth", severity: "P1", waivable: "none", title: "Authentication check removed" },
  "auth/boundary-changed": { category: "auth", severity: "P2", waivable: "none", title: "Authentication/authorization code changed" },
  "coverage/critical-without-tests": { category: "missing-coverage", severity: "P2", waivable: "architecture", title: "Critical workflow changed without test changes" },
  "check/failed": { category: "functional-regression", severity: "P1", waivable: "none", title: "Mandatory verification failed" },
} as const satisfies Record<string, RuleDefinition>;

export type RuleId = keyof typeof RULES;

export function rule(id: RuleId): RuleDefinition {
  return RULES[id];
}

export function isKnownRule(id: string): id is RuleId {
  return id in RULES;
}
