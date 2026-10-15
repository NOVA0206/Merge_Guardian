import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { canAccessJob } from "@/lib/access";
import { getSession } from "@/lib/session";
import { getStore } from "@/storage";
import { Pill, SeverityBadge } from "../../../_components/badges";
import { AutoRefresh, RetryButton } from "../../../_components/widgets";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect(`/api/auth/login?returnTo=${encodeURIComponent(`/dashboard/jobs/${id}`)}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const store = getStore();
  const job = await store.getJob(id);
  if (!job || !(await canAccessJob(session, job))) notFound();
  const [findings, audit] = await Promise.all([store.getFindings(id), store.listAudit({ jobId: id, limit: 30 })]);
  const active = job.status === "queued" || job.status === "running";
  const result = (job.result ?? {}) as { reasons?: string[]; checks?: Array<{ name: string; status: string }>; policyVersion?: string; guardianVersion?: string; filesChanged?: number; affectedModules?: string[] };
  const open = findings.filter((f) => f.status === "open" || f.status === "waived");

  return (
    <main>
      <nav className="text-sm"><Link className="text-emerald-700 hover:underline dark:text-emerald-400" href="/dashboard">← Dashboard</Link></nav>
      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl font-semibold">{job.repoFullName}#{job.prNumber}</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Head <code>{job.headSha.slice(0, 12)}</code> · base <code>{job.baseSha.slice(0, 12)}</code>
            {job.candidateSha && <> · merge candidate <code>{job.candidateSha.slice(0, 12)}</code></>}
          </p>
        </div>
        <div className="flex items-center gap-2"><Pill text={job.status} kind="status" />{job.decision && <Pill text={job.decision} kind="decision" />}</div>
      </header>
      <div className="mt-2"><AutoRefresh active={active} /></div>

      {job.status === "failed" && (
        <section role="alert" className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
          <h2 className="font-medium text-red-900 dark:text-red-200">Analysis failed (attempt {job.attempt} of {job.maxAttempts})</h2>
          <p className="mt-1 text-sm text-red-800 dark:text-red-300">{job.error ?? "Unknown error."}</p>
          <p className="mt-2 text-sm text-red-800 dark:text-red-300">The required check on this commit is failing closed until the analysis succeeds.</p>
          <div className="mt-3"><RetryButton jobId={job.id} /></div>
        </section>
      )}

      {result.reasons && result.reasons.length > 0 && (
        <section className="mt-6">
          <h2 className="font-medium">Why this decision</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{result.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </section>
      )}

      {result.checks && result.checks.length > 0 && (
        <section className="mt-6">
          <h2 className="font-medium">Verification results</h2>
          <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
            {result.checks.map((c) => <li key={c.name}><code>{c.name}</code>: {c.status}</li>)}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h2 className="font-medium">Findings ({open.length})</h2>
        {open.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{active ? "Analysis in progress…" : "No findings were reported for this revision."}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {open.map((f) => (
              <li key={f.id} className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={f.severity} />
                  <strong>{f.title}</strong>
                  <span className="text-xs text-slate-500">{f.kind} · {(f.confidence * 100).toFixed(0)}% · {f.ruleId}{f.status === "waived" ? " · waived" : ""}</span>
                </div>
                <p className="mt-2 text-sm">{f.description}</p>
                {f.evidence.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-slate-600 dark:text-slate-300">
                    {f.evidence.slice(0, 5).map((e, i) => <li key={i}><code>{e.file}{e.line ? `:${e.line}` : ""}</code> {e.detail}</li>)}
                  </ul>
                )}
                {f.recommendedFix && <p className="mt-2 text-sm"><strong>Required action:</strong> {f.recommendedFix}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="font-medium">Audit trail</h2>
        <ul className="mt-2 space-y-1 text-xs text-slate-600 dark:text-slate-300">
          <li>Policy version <code>{result.policyVersion ?? "—"}</code> · Guardian <code>{result.guardianVersion ?? "—"}</code> · files changed {result.filesChanged ?? "—"}</li>
          {audit.map((a, i) => <li key={i}><time dateTime={a.at}>{a.at}</time> · {a.actor} · {a.action}</li>)}
        </ul>
      </section>
    </main>
  );
}
