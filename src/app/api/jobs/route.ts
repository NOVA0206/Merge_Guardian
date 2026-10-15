import { NextResponse } from "next/server";
import { accessibleRepoNames } from "@/lib/access";
import { getSession } from "@/lib/session";
import { getStore } from "@/storage";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const repos = await accessibleRepoNames(session);
  if (repos !== "all" && repos.length === 0) return NextResponse.json({ jobs: [] });
  const jobs = await getStore().listJobs({ repoFullNames: repos === "all" ? undefined : repos, limit: 50 });
  return NextResponse.json({ jobs });
}
