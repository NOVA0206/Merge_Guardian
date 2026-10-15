import { NextResponse } from "next/server";
import { canAccessJob, isSameOrigin, rateLimited } from "@/lib/access";
import { dispatchJob } from "@/jobs/inngest";
import { getSession } from "@/lib/session";
import { getStore } from "@/storage";

export const dynamic = "force-dynamic";

/** Safely retry a FAILED job. Idempotent: the atomic requeue only succeeds once per failure. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const store = getStore();
  const job = await store.getJob(id);
  if (!job || !(await canAccessJob(session, job))) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (await rateLimited(session.login, "job.retry", 10, 60)) return NextResponse.json({ error: "rate limited" }, { status: 429 });

  const queued = await store.requeueJob(id);
  if (!queued) return NextResponse.json({ error: `job is ${job.status}; only failed jobs can be retried` }, { status: 409 });
  await store.appendAudit({ actor: session.login, action: "job.retry", repoFullName: job.repoFullName, prNumber: job.prNumber, headSha: job.headSha, jobId: id });
  await dispatchJob(queued, `retry-${queued.attempt}`);
  return NextResponse.json({ ok: true, job: queued });
}
