import { z } from "zod";

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

export const CATEGORIES = [
  "architecture-drift",
  "api-contract",
  "database-migration",
  "dependency",
  "auth",
  "environment",
  "security",
  "missing-coverage",
  "integration-conflict",
  "deployment-runtime",
  "functional-regression",
  "other",
] as const;
export const categorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof categorySchema>;

/** How strongly the evidence supports the finding (spec section 10). */
export const kindSchema = z.enum(["confirmed", "probable", "potential", "intentional", "informational"]);
export type FindingKind = z.infer<typeof kindSchema>;

export const evidenceSchema = z.object({
  source: z.enum(["static", "diff", "graph", "test", "model", "check-run"]),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  snippet: z.string().max(600).optional(),
  detail: z.string().max(1000),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const findingSchema = z.object({
  id: z.string().min(1),
  ruleId: z.string().min(1),
  origin: z.enum(["deterministic", "model"]),
  category: categorySchema,
  severity: severitySchema,
  confidence: z.number().min(0).max(1),
  kind: kindSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(2000),
  evidence: z.array(evidenceSchema),
  affectedFiles: z.array(z.string()),
  affectedModules: z.array(z.string()),
  potentialImpact: z.string().max(1500),
  recommendedFix: z.string().max(1500),
  requiredTests: z.array(z.string()),
  approvalRequired: z.boolean(),
  repairable: z.boolean().default(false),
  /** Machine-readable details for deterministic repairs (never rendered as trusted markup). */
  data: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["open", "waived", "resolved", "dismissed"]).default("open"),
});
export type Finding = z.infer<typeof findingSchema>;

/** Input shape for creating findings; id/status/defaults are filled by `makeFinding`. */
export type FindingInput = Omit<z.input<typeof findingSchema>, "id" | "status" | "origin" | "repairable" | "approvalRequired"> &
  Partial<Pick<Finding, "origin" | "repairable" | "approvalRequired" | "status">>;

export function findingId(ruleId: string, files: readonly string[], discriminator = ""): string {
  const key = [ruleId, ...[...files].sort(), discriminator].join("|");
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${ruleId}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function makeFinding(input: FindingInput, discriminator = ""): Finding {
  return findingSchema.parse({
    origin: "deterministic",
    approvalRequired: false,
    repairable: false,
    status: "open",
    ...input,
    id: findingId(input.ruleId, input.affectedFiles, discriminator),
  });
}

/** Result of one verification step (lint, build, ...). Absent or NOT_RUN is never success. */
export const checkStatusSchema = z.enum(["PASS", "FAIL", "NOT_RUN", "PENDING"]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const checkResultSchema = z.object({
  name: z.string(),
  status: checkStatusSchema,
  detailsUrl: z.string().optional(),
  headSha: z.string().optional(),
  summary: z.string().max(500).optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;
