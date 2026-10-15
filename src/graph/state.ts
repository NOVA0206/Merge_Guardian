import { Annotation } from "@langchain/langgraph";
import type { Finding } from "@/reporting/finding-schema";
import type { CheckResult } from "@/reporting/finding-schema";
import type { ReviewRecord } from "@/policy/approval-policy";
import type { PolicyDecision } from "@/policy/decisions";
import type { ImpactReport } from "@/analysis/impact-analysis";
import { z } from "zod";

export const workflowStatusSchema = z.enum([
  "running",
  "awaiting_checks",
  "awaiting_approval",
  "awaiting_commit",
  "complete",
  "stale",
  "error",
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

/** Validated input for starting a run. Everything else in the state is derived. */
export const guardianInputSchema = z.object({
  repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  jobId: z.string().min(1),
  runId: z.string().min(1),
  trigger: z.enum(["pull_request", "evaluate", "manual", "retry", "repair"]),
  /** Head SHA that triggered this run. A different current head makes the result STALE. */
  expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  repairRequested: z.boolean().default(false),
  /** Session created by an authorised /guardian fix request; carries finding id and requester. */
  repairSessionId: z.string().optional(),
});
export type GuardianInput = z.infer<typeof guardianInputSchema>;

export interface PrSummary {
  author: string;
  title: string;
  body: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  isFork: boolean;
  draft: boolean;
  state: "open" | "closed";
}

export interface RepairState {
  requested: boolean;
  attempts: number;
  sessionId?: string;
  branch?: string;
  repairPrNumber?: number;
  status: "none" | "proposed" | "failed" | "unavailable";
  detail?: string;
}

const replace = <T>(initial: () => T) => Annotation<T>({ reducer: (_a, b) => b, default: initial });
const concat = <T>() => Annotation<T[]>({ reducer: (a, b) => a.concat(b), default: () => [] });

/** Serializable (checkpoint-safe) workflow state. Large objects such as repo snapshots live in RunScope, not here. */
export const GuardianState = Annotation.Root({
  repoFullName: Annotation<string>(),
  installationId: Annotation<number>(),
  prNumber: Annotation<number>(),
  jobId: Annotation<string>(),
  runId: Annotation<string>(),
  trigger: Annotation<GuardianInput["trigger"]>(),
  expectedHeadSha: Annotation<string>(),
  startedAt: replace<string>(() => new Date().toISOString()),

  pr: Annotation<PrSummary | undefined>(),
  baseSha: Annotation<string | undefined>(),
  analyzedSha: Annotation<string | undefined>(),
  candidateSha: Annotation<string | undefined>(),
  mergeConflict: replace<boolean>(() => false),
  policyVersion: replace<string>(() => "unknown"),
  baselineReviewed: replace<boolean>(() => false),

  filesChanged: replace<number>(() => 0),
  impact: Annotation<ImpactReport | undefined>(),

  /** Findings from parallel analyzers are concatenated here, then de-duplicated into `findings`. */
  rawFindings: concat<Finding>(),
  findings: replace<Finding[]>(() => []),
  checks: replace<CheckResult[]>(() => []),
  reviews: replace<ReviewRecord[]>(() => []),
  aiStatus: replace<"ok" | "unavailable" | "skipped">(() => "skipped"),
  pendingExpired: replace<boolean>(() => false),

  decision: Annotation<PolicyDecision | undefined>(),
  workflowStatus: replace<WorkflowStatus>(() => "running"),
  approvalRounds: replace<number>(() => 0),
  repair: replace<RepairState>(() => ({ requested: false, attempts: 0, status: "none" })),
  report: replace<{ checkRunId?: number; commentId?: number; published: boolean }>(() => ({ published: false })),
  errors: concat<string>(),
});

export type GuardianStateType = typeof GuardianState.State;
export type GuardianUpdate = typeof GuardianState.Update;
