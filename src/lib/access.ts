import { getStore } from "@/storage";
import type { AnalysisJob } from "@/storage/store";
import { isAdmin, type Session } from "./session";

/** Repositories the signed-in user may see: only those under an installation they have access to. */
export async function accessibleRepoNames(session: Session): Promise<string[] | "all"> {
  if (isAdmin(session)) return "all";
  const repos = await getStore().listRepositories(session.installationIds);
  return repos.map((r) => r.fullName);
}

export async function canAccessJob(session: Session, job: AnalysisJob): Promise<boolean> {
  if (isAdmin(session)) return true;
  return session.installationIds.includes(job.installationId);
}

/** Same-origin check for state-changing requests (defence in depth on top of SameSite=Lax cookies). */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** DB-backed rate limit: counts the actor's recent audit entries, so it holds across serverless instances. */
export async function rateLimited(actor: string, action: string, max: number, windowSeconds: number): Promise<boolean> {
  const n = await getStore().countRecentAudit(actor, action, windowSeconds);
  return n >= max;
}
