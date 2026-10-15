import { NextResponse } from "next/server";
import { syncInstallation } from "@/github/installations";
import { appBaseUrl } from "@/lib/app-url";
import { getSession } from "@/lib/session";
import { getStore } from "@/storage";

export const dynamic = "force-dynamic";

/**
 * GitHub App "Setup URL". After installing, GitHub redirects here with ?installation_id=. We only sync
 * an installation that the signed-in user can actually access, so a crafted link cannot register someone else's.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = appBaseUrl(req);
  const id = Number(url.searchParams.get("installation_id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.redirect(`${base}/dashboard?error=bad_installation`);

  const session = await getSession();
  if (!session) {
    const back = `/api/github/setup?installation_id=${id}`;
    return NextResponse.redirect(`${base}/api/auth/login?returnTo=${encodeURIComponent(back)}`);
  }
  if (!session.installationIds.includes(id)) {
    // The session list is captured at sign-in; a fresh sign-in picks up a just-created installation once.
    if (url.searchParams.get("retry") !== "1") {
      const back = `/api/github/setup?installation_id=${id}&retry=1`;
      return NextResponse.redirect(`${base}/api/auth/login?returnTo=${encodeURIComponent(back)}`);
    }
    return NextResponse.redirect(`${base}/dashboard?error=not_authorized`);
  }
  try {
    const r = await syncInstallation(id, getStore());
    return NextResponse.redirect(`${base}/dashboard?connected=${encodeURIComponent(r.account)}`);
  } catch {
    return NextResponse.redirect(`${base}/dashboard?error=sync_failed`);
  }
}
