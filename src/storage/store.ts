import type { Finding } from "@/reporting/finding-schema";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "stale" | "cancelled";
export type JobTrigger = "pull_request" | "evaluate" | "manual" | "retry" | "repair";

export interface AnalysisJob {
  id: string;
  idempotencyKey: string;
  repoFullName: string;
  installationId: number;
  prNumber: number;
  baseSha: string;
  headSha: string;
  candidateSha?: string;
  trigger: JobTrigger;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  /** PASS | BLOCKED | ... — present once the job completed. */
  decision?: string;
  error?: string;
  /** Serializable run result (reasons, summary counts, check results). */
  result?: Record<string, unknown>;
  checkRunId?: number;
  reportCommentId?: number;
  deliveryId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface EnqueueInput {
  idempotencyKey: string;
  repoFullName: string;
  installationId: number;
  prNumber: number;
  baseSha: string;
  headSha: string;
  candidateSha?: string;
  trigger: JobTrigger;
  deliveryId?: string;
  maxAttempts?: number;
}

export interface InstallationRecord {
  id: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

export interface RepositoryRecord {
  id: number;
  installationId: number;
  fullName: string;
  defaultBranch: string;
  enabled: boolean;
}

export interface AuditEntry {
  at?: string;
  actor: string;
  action: string;
  repoFullName?: string;
  prNumber?: number;
  headSha?: string;
  jobId?: string;
  details?: Record<string, unknown>;
}

export interface PrState {
  repoFullName: string;
  prNumber: number;
  latestHeadSha: string;
  latestJobId?: string;
  updatedAt: string;
}

export interface RepairSession {
  id: string;
  repoFullName: string;
  prNumber: number;
  findingId: string;
  sourceHeadSha: string;
  branch: string;
  status: "requested" | "running" | "proposed" | "failed" | "rejected" | "applied";
  attempts: number;
  requestedBy: string;
  repairPrNumber?: number;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** All durable state goes through this interface. No implementation may keep authoritative state in process memory. */
export interface Store {
  /** Returns true the first time a delivery id is seen; false for duplicates. */
  recordDelivery(deliveryId: string, event: string): Promise<boolean>;
  /** Un-record a delivery whose processing failed, so GitHub's redelivery is processed instead of dropped. */
  forgetDelivery(deliveryId: string): Promise<void>;

  upsertInstallation(i: InstallationRecord): Promise<void>;
  upsertRepository(r: RepositoryRecord): Promise<void>;
  listRepositories(installationIds?: number[]): Promise<RepositoryRecord[]>;
  getRepository(fullName: string): Promise<RepositoryRecord | undefined>;
  setRepositoryEnabled(fullName: string, enabled: boolean): Promise<void>;
  listInstallations(): Promise<InstallationRecord[]>;
  removeInstallation(id: number): Promise<void>;

  /** Atomic: an existing job with the same idempotency key is returned with created=false. */
  enqueueJob(input: EnqueueInput): Promise<{ job: AnalysisJob; created: boolean }>;
  getJob(id: string): Promise<AnalysisJob | undefined>;
  listJobs(filter: { repoFullNames?: string[]; limit?: number; prNumber?: number; repoFullName?: string }): Promise<AnalysisJob[]>;
  /** queued|failed(with attempts left) -> running. Returns undefined if another worker owns it or it is terminal. */
  claimJob(id: string): Promise<AnalysisJob | undefined>;
  updateJob(id: string, patch: Partial<Pick<AnalysisJob, "status" | "decision" | "error" | "result" | "checkRunId" | "reportCommentId" | "candidateSha" | "baseSha">>): Promise<AnalysisJob>;
  /** Mark queued/running jobs for older heads of this PR as stale; returns affected job ids. */
  supersedeJobs(repoFullName: string, prNumber: number, currentHeadSha: string): Promise<string[]>;
  /** Jobs that were queued but never picked up (lost event), whose worker died mid-run, or that failed while GitHub was unreachable so their failure check was never published. */
  listStuckJobs(olderThanMinutes: number, limit?: number): Promise<AnalysisJob[]>;
  /** Re-queue a failed job for manual retry (resets attempt budget by one). */
  requeueJob(id: string): Promise<AnalysisJob | undefined>;

  saveFindings(jobId: string, findings: readonly Finding[]): Promise<void>;
  getFindings(jobId: string): Promise<Finding[]>;

  getPrState(repoFullName: string, prNumber: number): Promise<PrState | undefined>;
  setPrState(state: PrState): Promise<void>;

  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(filter: { repoFullName?: string; prNumber?: number; jobId?: string; limit?: number }): Promise<AuditEntry[]>;

  /** Count audit entries by an actor for an action since N seconds ago (DB-backed, so rate limits hold across serverless instances). */
  countRecentAudit(actor: string, action: string, sinceSeconds: number): Promise<number>;

  createRepairSession(s: Omit<RepairSession, "createdAt" | "updatedAt" | "id" | "attempts">): Promise<RepairSession>;
  updateRepairSession(id: string, patch: Partial<Pick<RepairSession, "status" | "attempts" | "repairPrNumber" | "result">>): Promise<RepairSession>;
  getRepairSession(id: string): Promise<RepairSession | undefined>;
  listRepairSessions(filter: { repoFullName?: string; prNumber?: number }): Promise<RepairSession[]>;

  ping(): Promise<void>;
}
