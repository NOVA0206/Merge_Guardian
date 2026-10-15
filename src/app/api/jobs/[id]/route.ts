import { NextResponse } from "next/server";
import { canAccessJob } from "@/lib/access";
import { getSession } from "@/lib/session";
import { getStore } from "@/storage";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const store = getStore();
  const job = await store.getJob(id);
  if (!job || !(await canAccessJob(session, job))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [findings, audit] = await Promise.all([store.getFindings(id), store.listAudit({ jobId: id, limit: 50 })]);
  return NextResponse.json({ job, findings, audit });
}
