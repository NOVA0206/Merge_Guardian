import { randomUUID } from "node:crypto";
import type { Finding } from "@/reporting/finding-schema";
import type {
  AnalysisJob,
  AuditEntry,
  EnqueueInput,
  InstallationRecord,
  PrState,
  RepairSession,
  RepositoryRecord,
  Store,
} from "./store";

const now = () => new Date().toISOString();

/**
 * In-memory Store used ONLY by unit/integration tests. It is never wired into the deployed app:
 * `getStore()` throws in production if DATABASE_URL is missing instead of falling back to this.
 */
export class MemoryStore implements Store {
  private deliveries = new Set<string>();
  private installations = new Map<number, InstallationRecord>();
  private repos = new Map<string, RepositoryRecord>();
  private jobs = new Map<string, AnalysisJob>();
  private byKey = new Map<string, string>();
  private findings = new Map<string, Finding[]>();
  private pr = new Map<string, PrState>();
  private audit: AuditEntry[] = [];
  private repairs = new Map<string, RepairSession>();

  async recordDelivery(id: string): Promise<boolean> {
    if (this.deliveries.has(id)) return false;
    this.deliveries.add(id);
    return true;
  }
  async forgetDelivery(id: string) {
    this.deliveries.delete(id);
  }
  async upsertInstallation(i: InstallationRecord) {
    this.installations.set(i.id, i);
  }
  async upsertRepository(r: RepositoryRecord) {
    const existing = this.repos.get(r.fullName);
    this.repos.set(r.fullName, { ...r, enabled: existing ? existing.enabled : r.enabled });
  }
  async listRepositories(installationIds?: number[]) {
    return [...this.repos.values()].filter((r) => !installationIds || installationIds.includes(r.installationId));
  }
  async getRepository(fullName: string) {
    return this.repos.get(fullName);
  }
  async setRepositoryEnabled(fullName: string, enabled: boolean) {
    const r = this.repos.get(fullName);
    if (r) this.repos.set(fullName, { ...r, enabled });
  }
  async listInstallations() {
    return [...this.installations.values()];
  }
  async removeInstallation(id: number) {
    this.installations.delete(id);
    for (const [k, r] of this.repos) if (r.installationId === id) this.repos.delete(k);
  }

  async enqueueJob(input: EnqueueInput) {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) return { job: this.jobs.get(existingId)!, created: false };
    const t = now();
    const job: AnalysisJob = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      repoFullName: input.repoFullName,
      installationId: input.installationId,
      prNumber: input.prNumber,
      baseSha: input.baseSha,
      headSha: input.headSha,
      candidateSha: input.candidateSha,
      trigger: input.trigger,
      status: "queued",
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      deliveryId: input.deliveryId,
      createdAt: t,
      updatedAt: t,
    };
    this.jobs.set(job.id, job);
    this.byKey.set(input.idempotencyKey, job.id);
    return { job, created: true };
  }
  async getJob(id: string) {
    return this.jobs.get(id);
  }
  async listJobs(f: { repoFullNames?: string[]; limit?: number; prNumber?: number; repoFullName?: string }) {
    return [...this.jobs.values()]
      .filter((j) => (!f.repoFullNames || f.repoFullNames.includes(j.repoFullName)) && (!f.repoFullName || j.repoFullName === f.repoFullName) && (f.prNumber === undefined || j.prNumber === f.prNumber))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, f.limit ?? 50);
  }
  async claimJob(id: string) {
    const j = this.jobs.get(id);
    if (!j || (j.status !== "queued" && !(j.status === "failed" && j.attempt < j.maxAttempts))) return undefined;
    const claimed = { ...j, status: "running" as const, attempt: j.attempt + 1, startedAt: now(), updatedAt: now(), error: undefined };
    this.jobs.set(id, claimed);
    return claimed;
  }
  async updateJob(id: string, patch: Parameters<Store["updateJob"]>[1]) {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`job ${id} not found`);
    const terminal = patch.status && ["succeeded", "failed", "stale", "cancelled"].includes(patch.status);
    const updated = { ...j, ...patch, updatedAt: now(), completedAt: terminal ? now() : j.completedAt };
    this.jobs.set(id, updated);
    return updated;
  }
  async supersedeJobs(repo: string, prNumber: number, currentHead: string) {
    const ids: string[] = [];
    for (const j of this.jobs.values()) {
      if (j.repoFullName === repo && j.prNumber === prNumber && j.headSha !== currentHead && (j.status === "queued" || j.status === "running")) {
        this.jobs.set(j.id, { ...j, status: "stale", updatedAt: now(), completedAt: now() });
        ids.push(j.id);
      }
    }
    return ids;
  }
  async listStuckJobs(olderThanMinutes: number, limit = 50) {
    const cutoff = Date.now() - olderThanMinutes * 60_000;
    return [...this.jobs.values()]
      .filter((j) => {
        if (Date.parse(j.updatedAt) >= cutoff) return false;
        if (j.status === "queued" || j.status === "running") return true;
        return j.status === "failed" && j.attempt >= j.maxAttempts && j.result?.failureCheckPublished !== true && Date.parse(j.updatedAt) > Date.now() - 6 * 3_600_000;
      })
      .slice(0, limit);
  }
  async requeueJob(id: string) {
    const j = this.jobs.get(id);
    if (!j || j.status !== "failed") return undefined;
    const q = { ...j, status: "queued" as const, maxAttempts: Math.max(j.maxAttempts, j.attempt + 1), updatedAt: now(), completedAt: undefined };
    this.jobs.set(id, q);
    return q;
  }

  async saveFindings(jobId: string, findings: readonly Finding[]) {
    this.findings.set(jobId, [...findings]);
  }
  async getFindings(jobId: string) {
    return this.findings.get(jobId) ?? [];
  }
  async getPrState(repo: string, pr: number) {
    return this.pr.get(`${repo}#${pr}`);
  }
  async setPrState(s: PrState) {
    this.pr.set(`${s.repoFullName}#${s.prNumber}`, s);
  }
  async appendAudit(e: AuditEntry) {
    this.audit.push({ ...e, at: e.at ?? now() });
  }
  async listAudit(f: { repoFullName?: string; prNumber?: number; jobId?: string; limit?: number }) {
    return this.audit
      .filter((e) => (!f.repoFullName || e.repoFullName === f.repoFullName) && (f.prNumber === undefined || e.prNumber === f.prNumber) && (!f.jobId || e.jobId === f.jobId))
      .slice(-(f.limit ?? 100))
      .reverse();
  }

  async countRecentAudit(actor: string, action: string, sinceSeconds: number) {
    const cutoff = Date.now() - sinceSeconds * 1000;
    return this.audit.filter((e) => e.actor === actor && e.action === action && Date.parse(e.at ?? "") >= cutoff).length;
  }

  async createRepairSession(s: Omit<RepairSession, "createdAt" | "updatedAt" | "id" | "attempts">) {
    const r: RepairSession = { ...s, id: randomUUID(), attempts: 0, createdAt: now(), updatedAt: now() };
    this.repairs.set(r.id, r);
    return r;
  }
  async updateRepairSession(id: string, patch: Parameters<Store["updateRepairSession"]>[1]) {
    const r = this.repairs.get(id);
    if (!r) throw new Error(`repair session ${id} not found`);
    const u = { ...r, ...patch, updatedAt: now() };
    this.repairs.set(id, u);
    return u;
  }
  async getRepairSession(id: string) {
    return this.repairs.get(id);
  }
  async listRepairSessions(f: { repoFullName?: string; prNumber?: number }) {
    return [...this.repairs.values()].filter((r) => (!f.repoFullName || r.repoFullName === f.repoFullName) && (f.prNumber === undefined || r.prNumber === f.prNumber));
  }
  async ping() {}
}
