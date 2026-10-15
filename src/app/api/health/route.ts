import { NextResponse } from "next/server";
import { configStatus } from "@/config/env";
import { GUARDIAN_VERSION } from "@/jobs/production";
import { getSession, isAdmin } from "@/lib/session";
import { getStore } from "@/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Liveness + readiness. Public callers get booleans only. Variable NAMES that are missing are shown
 * solely to signed-in admins; values are never returned.
 */
export async function GET() {
  const cfg = configStatus();
  let database: "ok" | "unreachable" | "not_configured" = "not_configured";
  if (process.env.DATABASE_URL) {
    try {
      await getStore().ping();
      database = "ok";
    } catch {
      database = "unreachable";
    }
  }
  const ready = cfg.ok && database === "ok";
  let detail: Record<string, unknown> = {};
  try {
    const session = await getSession();
    if (session && isAdmin(session)) detail = { missing: cfg.missing, invalid: cfg.invalid };
  } catch {
    /* session secret may itself be missing; stay public */
  }
  return NextResponse.json(
    {
      status: ready ? "ok" : "degraded",
      version: GUARDIAN_VERSION,
      // Lets CI prove which commit a deployment serves (Vercel injects this at build/run time). Not a secret.
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      checks: { configuration: cfg.ok, database, ai: cfg.aiConfigured, durableJobs: cfg.jobsConfigured },
      ...detail,
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
