import { z } from "zod";
import YAML from "yaml";
import { severitySchema } from "@/reporting/finding-schema";
import { ValidationError } from "@/errors";

/* ---------- architecture.yaml ---------- */
export const architectureSchema = z.object({
  version: z.number().int(),
  framework: z.string(),
  runtime: z.string(),
  packageManager: z.string(),
  /** Set to false until a human has reviewed uncertain discovered rules (spec section 6). */
  reviewed: z.boolean().default(false),
  layers: z.array(z.object({ name: z.string(), paths: z.array(z.string()), mayDependOn: z.array(z.string()) })).default([]),
  criticalWorkflows: z.array(z.object({ id: z.string(), description: z.string(), paths: z.array(z.string()) })).default([]),
  protectedDecisions: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
        /** Forbidden import edge: files matching `from` may not import files matching `to`. */
        forbiddenImport: z.object({ from: z.string(), to: z.string() }).optional(),
        /** File globs whose modification is an architecture change requiring approval. */
        protectedPaths: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
export type ArchitectureConfig = z.infer<typeof architectureSchema>;

/* ---------- module-map.yaml ---------- */
export const moduleMapSchema = z.object({
  version: z.number().int(),
  modules: z.array(
    z.object({
      name: z.string(),
      paths: z.array(z.string()).min(1),
      dependsOn: z.array(z.string()).default([]),
      /** If non-empty, other modules may only import these files. */
      publicInterface: z.array(z.string()).default([]),
      shared: z.boolean().default(false),
      criticalConsumers: z.array(z.string()).default([]),
    }),
  ),
});
export type ModuleMapConfig = z.infer<typeof moduleMapSchema>;

/* ---------- protected-contracts.yaml ---------- */
export const protectedContractsSchema = z.object({
  version: z.number().int(),
  apiContracts: z
    .array(
      z.object({
        id: z.string(),
        /** URL path consumers call, e.g. /api/proposals */
        route: z.string(),
        /** File that implements the route handler. */
        file: z.string(),
        /** Response fields that must remain. */
        responseFields: z.array(z.string()).default([]),
        consumers: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  databaseExpectations: z
    .array(z.object({ table: z.string(), columns: z.array(z.string()) }))
    .default([]),
  sharedSymbols: z.array(z.object({ file: z.string(), exports: z.array(z.string()) })).default([]),
  externalServices: z.array(z.object({ name: z.string(), envVars: z.array(z.string()).default([]) })).default([]),
});
export type ProtectedContractsConfig = z.infer<typeof protectedContractsSchema>;

/* ---------- risk-policy.yaml ---------- */
export const riskPolicySchema = z.object({
  version: z.number().int(),
  /** Severities that block merging when open. */
  blockingSeverities: z.array(severitySchema).default(["P0", "P1"]),
  /** Medium findings: require explicit review? */
  mediumRequiresReview: z.boolean().default(false),
  /** Checks that must be PASS on the exact head SHA. Missing = not success. */
  mandatoryChecks: z.array(z.string()).default([]),
  /** Rule ids / categories that no approval may waive. */
  nonWaivable: z.object({ categories: z.array(z.string()).default(["security", "auth"]), ruleIds: z.array(z.string()).default([]) }).default({
    categories: ["security", "auth"],
    ruleIds: [],
  }),
  severityOverrides: z.record(z.string(), severitySchema).default({}),
  confidence: z
    .object({
      /** Model-originated findings below this are capped at `lowConfidenceCap`. */
      minForBlocking: z.number().min(0).max(1).default(0.7),
      lowConfidenceCap: severitySchema.default("P3"),
    })
    .default({ minForBlocking: 0.7, lowConfidenceCap: "P3" }),
  approval: z
    .object({
      /** GitHub logins allowed to approve intentional architecture changes. */
      architectureApprovers: z.array(z.string()).default([]),
      securityApprovers: z.array(z.string()).default([]),
      requiredApprovals: z.number().int().min(1).default(1),
    })
    .default({ architectureApprovers: [], securityApprovers: [], requiredApprovals: 1 }),
  /** Fail the check (ERROR) when the AI provider is unavailable. Deterministic gates always run. */
  aiRequired: z.boolean().default(false),
});
export type RiskPolicy = z.infer<typeof riskPolicySchema>;

/* ---------- environment-requirements.yaml ---------- */
export const environmentSchema = z.object({
  version: z.number().int(),
  variables: z.array(
    z.object({
      name: z.string(),
      scope: z.enum(["server", "browser"]).default("server"),
      environments: z.array(z.enum(["development", "preview", "production"])).default(["development", "preview", "production"]),
      description: z.string().default(""),
    }),
  ),
  /** Settings that must match across environments (names only). */
  mustMatchAcrossEnvironments: z.array(z.string()).default([]),
});
export type EnvironmentConfig = z.infer<typeof environmentSchema>;

/* ---------- test-matrix.yaml ---------- */
export const testMatrixSchema = z.object({
  version: z.number().int(),
  features: z.array(
    z.object({
      id: z.string(),
      description: z.string().default(""),
      /** Source globs that, when changed, trigger this feature's tests. */
      sources: z.array(z.string()),
      critical: z.boolean().default(false),
      tests: z
        .object({
          unit: z.array(z.string()).default([]),
          integration: z.array(z.string()).default([]),
          contract: z.array(z.string()).default([]),
          database: z.array(z.string()).default([]),
          browser: z.array(z.string()).default([]),
          smoke: z.array(z.string()).default([]),
        })
        .default({ unit: [], integration: [], contract: [], database: [], browser: [], smoke: [] }),
    }),
  ),
});
export type TestMatrixConfig = z.infer<typeof testMatrixSchema>;

export interface GuardianConfig {
  architecture: ArchitectureConfig;
  moduleMap: ModuleMapConfig;
  contracts: ProtectedContractsConfig;
  policy: RiskPolicy;
  environment: EnvironmentConfig;
  testMatrix: TestMatrixConfig;
  /** Short content hash used as the "policy version" in audit records. */
  version: string;
}

export const GUARDIAN_FILES = {
  architecture: ".guardian/architecture.yaml",
  moduleMap: ".guardian/module-map.yaml",
  contracts: ".guardian/protected-contracts.yaml",
  policy: ".guardian/risk-policy.yaml",
  environment: ".guardian/environment-requirements.yaml",
  testMatrix: ".guardian/test-matrix.yaml",
} as const;

function parseYaml<T>(file: string, text: string | undefined, schema: z.ZodType<T>): T {
  if (text === undefined) throw new ValidationError(`Missing Guardian config file: ${file}`);
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new ValidationError(`Invalid YAML in ${file}: ${(e as Error).message}`);
  }
  const res = schema.safeParse(raw);
  if (!res.success) {
    throw new ValidationError(`Invalid ${file}: ${res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return res.data;
}

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Parse the six `.guardian` files from a file reader (virtual snapshot, API or disk). */
export function parseGuardianConfig(read: (path: string) => string | undefined): GuardianConfig {
  const texts = Object.values(GUARDIAN_FILES).map((f) => read(f) ?? "");
  return {
    architecture: parseYaml(GUARDIAN_FILES.architecture, read(GUARDIAN_FILES.architecture), architectureSchema),
    moduleMap: parseYaml(GUARDIAN_FILES.moduleMap, read(GUARDIAN_FILES.moduleMap), moduleMapSchema),
    contracts: parseYaml(GUARDIAN_FILES.contracts, read(GUARDIAN_FILES.contracts), protectedContractsSchema),
    policy: parseYaml(GUARDIAN_FILES.policy, read(GUARDIAN_FILES.policy), riskPolicySchema),
    environment: parseYaml(GUARDIAN_FILES.environment, read(GUARDIAN_FILES.environment), environmentSchema),
    testMatrix: parseYaml(GUARDIAN_FILES.testMatrix, read(GUARDIAN_FILES.testMatrix), testMatrixSchema),
    version: hashString(texts.join("\u0000")),
  };
}
