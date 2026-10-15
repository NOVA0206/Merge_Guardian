import pg from "pg";
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

/** A running job not touched for this long is presumed crashed and may be re-claimed. */
const LEASE_MINUTES = 15;

type Row = Record<string, any>;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

function toJob(r: Row): AnalysisJob {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    repoFullName: r.repo_full_name,
    installationId: Number(r.installation_id),
    prNumber: r.pr_number,
    baseSha: r.base_sha,
    headSha: r.head_sha,
    candidateSha: r.candidate_sha ?? undefined,
    trigger: r.trigger,
    status: r.status,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    decision: r.decision ?? undefined,
    error: r.error ?? undefined,
    result: r.result ?? undefined,
    checkRunId: num(r.check_run_id),
    reportCommentId: num(r.report_comment_id),
    deliveryId: r.delivery_id ?? undefined,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    startedAt: iso(r.started_at),
    completedAt: iso(r.completed_at),
  };
}

function toRepair(r: Row): RepairSession {
  return {
    id: r.id,
    repoFullName: r.repo_full_name,
    prNumber: r.pr_number,
    findingId: r.finding_id,
    sourceHeadSha: r.source_head_sha,
    branch: r.branch,
    status: r.status,
    attempts: r.attempts,
    requestedBy: r.requested_by,
    repairPrNumber: r.repair_pr_number ?? undefined,
    result: r.result ?? undefined,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

const JOB_COLUMNS: Record<string, string> = {
  status: "status",
  decision: "decision",
  error: "error",
  result: "result",
  checkRunId: "check_run_id",
  reportCommentId: "report_comment_id",
  candidateSha: "candidate_sha",
  baseSha: "base_sha",
};

let pool: pg.Pool | undefined;

/** One small pool per warm serverless instance; Vercel scales instances, so keep `max` low and use a pooled DATABASE_URL. */
export function getPool(connectionString: string): pg.Pool {
  pool ??= new pg.Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: false },
  });
  return pool;
}

export class PostgresStore implements Store {
  constructor(private readonly db: Pick<pg.Pool, "query">) {}

  async ping() {
    await this.db.query("select 1");
  }

  async recordDelivery(deliveryId: string, event: string) {
    const r = await this.db.query("insert into webhook_deliveries(delivery_id, event) values ($1,$2) on conflict do nothing", [deliveryId, event]);
    return (r.rowCount ?? 0) > 0;
  }

  async forgetDelivery(id: string) {
    await this.db.query("delete from webhook_deliveries where delivery_id=$1", [id]);
  }

  async upsertInstallation(i: InstallationRecord) {
    await this.db.query(
      `insert into installations(id, account_login, account_type, suspended) values ($1,$2,$3,$4)
       on conflict (id) do update set account_login=excluded.account_login, account_type=excluded.account_type, suspended=excluded.suspended, updated_at=now()`,
      [i.id, i.accountLogin, i.accountType, i.suspended],
    );
  }
  async upsertRepository(r: RepositoryRecord) {
    await this.db.query(
      `insert into repositories(id, installation_id, full_name, default_branch, enabled) values ($1,$2,$3,$4,$5)
       on conflict (id) do update set installation_id=excluded.installation_id, full_name=excluded.full_name, default_branch=excluded.default_branch`,
      [r.id, r.installationId, r.fullName, r.defaultBranch, r.enabled],
    );
  }
  async listRepositories(installationIds?: number[]) {
    const r = installationIds
      ? await this.db.query("select * from repositories where installation_id = any($1::bigint[]) order by full_name", [installationIds])
      : await this.db.query("select * from repositories order by full_name");
    return r.rows.map((x: Row) => ({ id: Number(x.id), installationId: Number(x.installation_id), fullName: x.full_name, defaultBranch: x.default_branch, enabled: x.enabled }));
  }
  async getRepository(fullName: string) {
    const r = await this.db.query("select * from repositories where full_name=$1", [fullName]);
    const x = r.rows[0];
    return x ? { id: Number(x.id), installationId: Number(x.installation_id), fullName: x.full_name, defaultBranch: x.default_branch, enabled: x.enabled } : undefined;
  }
  async setRepositoryEnabled(fullName: string, enabled: boolean) {
    await this.db.query("update repositories set enabled=$2 where full_name=$1", [fullName, enabled]);
  }
  async listInstallations() {
    const r = await this.db.query("select * from installations order by account_login");
    return r.rows.map((x: Row) => ({ id: Number(x.id), accountLogin: x.account_login, accountType: x.account_type, suspended: x.suspended }));
  }
  async removeInstallation(id: number) {
    await this.db.query("delete from installations where id=$1", [id]);
  }

  async enqueueJob(i: EnqueueInput) {
    const ins = await this.db.query(
      `insert into analysis_jobs(idempotency_key, repo_full_name, installation_id, pr_number, base_sha, head_sha, candidate_sha, trigger, status, max_attempts, delivery_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10) on conflict (idempotency_key) do nothing returning *`,
      [i.idempotencyKey, i.repoFullName, i.installationId, i.prNumber, i.baseSha, i.headSha, i.candidateSha ?? null, i.trigger, i.maxAttempts ?? 3, i.deliveryId ?? null],
    );
    if (ins.rows[0]) return { job: toJob(ins.rows[0]), created: true };
    const existing = await this.db.query("select * from analysis_jobs where idempotency_key=$1", [i.idempotencyKey]);
    return { job: toJob(existing.rows[0]), created: false };
  }
  async getJob(id: string) {
    const r = await this.db.query("select * from analysis_jobs where id=$1", [id]);
    return r.rows[0] ? toJob(r.rows[0]) : undefined;
  }
  async listJobs(f: { repoFullNames?: string[]; limit?: number; prNumber?: number; repoFullName?: string }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.repoFullNames) (args.push(f.repoFullNames), where.push(`repo_full_name = any($${args.length}::text[])`));
    if (f.repoFullName) (args.push(f.repoFullName), where.push(`repo_full_name = $${args.length}`));
    if (f.prNumber !== undefined) (args.push(f.prNumber), where.push(`pr_number = $${args.length}`));
    args.push(Math.min(f.limit ?? 50, 200));
    const r = await this.db.query(`select * from analysis_jobs ${where.length ? "where " + where.join(" and ") : ""} order by created_at desc limit $${args.length}`, args);
    return r.rows.map(toJob);
  }
  async claimJob(id: string) {
    const r = await this.db.query(
      `update analysis_jobs set status='running', attempt=attempt+1, started_at=now(), updated_at=now(), error=null
       where id=$1 and (
         status='queued'
         or (status='failed' and attempt < max_attempts)
         or (status='running' and updated_at < now() - interval '${LEASE_MINUTES} minutes' and attempt < max_attempts)
       ) returning *`,
      [id],
    );
    return r.rows[0] ? toJob(r.rows[0]) : undefined;
  }
  async updateJob(id: string, patch: Parameters<Store["updateJob"]>[1]) {
    const sets: string[] = ["updated_at=now()"];
    const args: unknown[] = [id];
    for (const [k, v] of Object.entries(patch)) {
      const col = JOB_COLUMNS[k];
      if (!col || v === undefined) continue;
      args.push(k === "result" ? JSON.stringify(v) : v);
      sets.push(`${col}=$${args.length}${k === "result" ? "::jsonb" : ""}`);
    }
    if (patch.status && ["succeeded", "failed", "stale", "cancelled"].includes(patch.status)) sets.push("completed_at=now()");
    const r = await this.db.query(`update analysis_jobs set ${sets.join(", ")} where id=$1 returning *`, args);
    if (!r.rows[0]) throw new Error(`job ${id} not found`);
    return toJob(r.rows[0]);
  }
  async supersedeJobs(repo: string, prNumber: number, currentHead: string) {
    const r = await this.db.query(
      `update analysis_jobs set status='stale', updated_at=now(), completed_at=now()
       where repo_full_name=$1 and pr_number=$2 and head_sha<>$3 and status in ('queued','running') returning id`,
      [repo, prNumber, currentHead],
    );
    return r.rows.map((x: Row) => x.id as string);
  }
  async listStuckJobs(olderThanMinutes: number, limit = 50) {
    const r = await this.db.query(
      `select * from analysis_jobs
       where updated_at < now() - ($1::int * interval '1 minute')
         and (
           status in ('queued','running')
           or (status = 'failed' and attempt >= max_attempts
               and coalesce(result->>'failureCheckPublished','false') <> 'true'
               and updated_at > now() - interval '6 hours')
         )
       order by updated_at limit $2`,
      [olderThanMinutes, limit],
    );
    return r.rows.map(toJob);
  }
  async requeueJob(id: string) {
    const r = await this.db.query(
      `update analysis_jobs set status='queued', max_attempts=greatest(max_attempts, attempt+1), updated_at=now(), completed_at=null
       where id=$1 and status='failed' returning *`,
      [id],
    );
    return r.rows[0] ? toJob(r.rows[0]) : undefined;
  }

  async saveFindings(jobId: string, findings: readonly Finding[]) {
    await this.db.query("delete from findings where job_id=$1", [jobId]);
    for (const f of findings) {
      await this.db.query(
        "insert into findings(job_id, finding_id, rule_id, severity, data) values ($1,$2,$3,$4,$5::jsonb) on conflict (job_id, finding_id) do update set data=excluded.data, severity=excluded.severity",
        [jobId, f.id, f.ruleId, f.severity, JSON.stringify(f)],
      );
    }
  }
  async getFindings(jobId: string) {
    const r = await this.db.query("select data from findings where job_id=$1 order by severity, finding_id", [jobId]);
    return r.rows.map((x: Row) => x.data as Finding);
  }

  async getPrState(repo: string, pr: number) {
    const r = await this.db.query("select * from pr_state where repo_full_name=$1 and pr_number=$2", [repo, pr]);
    const x = r.rows[0];
    return x ? { repoFullName: x.repo_full_name, prNumber: x.pr_number, latestHeadSha: x.latest_head_sha, latestJobId: x.latest_job_id ?? undefined, updatedAt: iso(x.updated_at)! } : undefined;
  }
  async setPrState(s: PrState) {
    await this.db.query(
      `insert into pr_state(repo_full_name, pr_number, latest_head_sha, latest_job_id) values ($1,$2,$3,$4)
       on conflict (repo_full_name, pr_number) do update set latest_head_sha=excluded.latest_head_sha, latest_job_id=excluded.latest_job_id, updated_at=now()`,
      [s.repoFullName, s.prNumber, s.latestHeadSha, s.latestJobId ?? null],
    );
  }

  async appendAudit(e: AuditEntry) {
    await this.db.query(
      "insert into audit_log(actor, action, repo_full_name, pr_number, head_sha, job_id, details) values ($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [e.actor, e.action, e.repoFullName ?? null, e.prNumber ?? null, e.headSha ?? null, e.jobId ?? null, e.details ? JSON.stringify(e.details) : null],
    );
  }
  async listAudit(f: { repoFullName?: string; prNumber?: number; jobId?: string; limit?: number }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.repoFullName) (args.push(f.repoFullName), where.push(`repo_full_name=$${args.length}`));
    if (f.prNumber !== undefined) (args.push(f.prNumber), where.push(`pr_number=$${args.length}`));
    if (f.jobId) (args.push(f.jobId), where.push(`job_id=$${args.length}`));
    args.push(Math.min(f.limit ?? 100, 500));
    const r = await this.db.query(`select * from audit_log ${where.length ? "where " + where.join(" and ") : ""} order by at desc, id desc limit $${args.length}`, args);
    return r.rows.map((x: Row) => ({ at: iso(x.at), actor: x.actor, action: x.action, repoFullName: x.repo_full_name ?? undefined, prNumber: x.pr_number ?? undefined, headSha: x.head_sha ?? undefined, jobId: x.job_id ?? undefined, details: x.details ?? undefined }));
  }

  async countRecentAudit(actor: string, action: string, sinceSeconds: number) {
    const r = await this.db.query("select count(*)::int as n from audit_log where actor=$1 and action=$2 and at > now() - ($3::int * interval '1 second')", [actor, action, sinceSeconds]);
    return Number(r.rows[0]?.n ?? 0);
  }

  async createRepairSession(s: Omit<RepairSession, "createdAt" | "updatedAt" | "id" | "attempts">) {
    const r = await this.db.query(
      "insert into repair_sessions(repo_full_name, pr_number, finding_id, source_head_sha, branch, status, requested_by) values ($1,$2,$3,$4,$5,$6,$7) returning *",
      [s.repoFullName, s.prNumber, s.findingId, s.sourceHeadSha, s.branch, s.status, s.requestedBy],
    );
    return toRepair(r.rows[0]);
  }
  async updateRepairSession(id: string, patch: Parameters<Store["updateRepairSession"]>[1]) {
    const r = await this.db.query(
      `update repair_sessions set status=coalesce($2,status), attempts=coalesce($3,attempts), repair_pr_number=coalesce($4,repair_pr_number), result=coalesce($5::jsonb,result), updated_at=now() where id=$1 returning *`,
      [id, patch.status ?? null, patch.attempts ?? null, patch.repairPrNumber ?? null, patch.result ? JSON.stringify(patch.result) : null],
    );
    if (!r.rows[0]) throw new Error(`repair session ${id} not found`);
    return toRepair(r.rows[0]);
  }
  async getRepairSession(id: string) {
    const r = await this.db.query("select * from repair_sessions where id=$1", [id]);
    return r.rows[0] ? toRepair(r.rows[0]) : undefined;
  }
  async listRepairSessions(f: { repoFullName?: string; prNumber?: number }) {
    const r = await this.db.query(
      "select * from repair_sessions where ($1::text is null or repo_full_name=$1) and ($2::int is null or pr_number=$2) order by created_at desc limit 100",
      [f.repoFullName ?? null, f.prNumber ?? null],
    );
    return r.rows.map(toRepair);
  }
}
