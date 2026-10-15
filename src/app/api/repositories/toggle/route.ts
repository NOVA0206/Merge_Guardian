import { NextResponse } from "next/server";
import { z } from "zod";
import { isSameOrigin } from "@/lib/access";
import { getSession, isAdmin } from "@/lib/session";
import { getStore } from "@/storage";

export const dynamic = "force-dynamic";

const body = z.object({ fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), enabled: z.boolean() });

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const store = getStore();
  const repo = await store.getRepository(parsed.data.fullName);
  if (!repo || !(isAdmin(session) || session.installationIds.includes(repo.installationId))) return NextResponse.json({ error: "not found" }, { status: 404 });
  await store.setRepositoryEnabled(repo.fullName, parsed.data.enabled);
  await store.appendAudit({ actor: session.login, action: parsed.data.enabled ? "repository.enabled" : "repository.disabled", repoFullName: repo.fullName });
  return NextResponse.json({ ok: true });
}
