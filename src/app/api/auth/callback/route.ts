import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/app-url";
import { exchangeCode, fetchUser, fetchUserInstallations } from "@/lib/github-oauth";
import { OAUTH_STATE_COOKIE, SESSION_COOKIE, safeReturnTo, sessionCookieOptions, signSession } from "@/lib/session";
import { getStore } from "@/storage";

export const dynamic = "force-dynamic";

function sameString(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = appBaseUrl(req);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = req.headers.get("cookie")?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
  const stored = cookie?.slice(OAUTH_STATE_COOKIE.length + 1);
  const [expectedState, returnToEncoded] = (stored ?? "").split(".");

  const fail = (reason: string) => {
    const r = NextResponse.redirect(`${base}/?error=${reason}`);
    r.cookies.delete(OAUTH_STATE_COOKIE);
    return r;
  };
  if (!code || !state || !expectedState || !sameString(state, expectedState)) return fail("oauth_state");

  try {
    const token = await exchangeCode(code, `${base}/api/auth/callback`);
    const [user, installationIds] = await Promise.all([fetchUser(token), fetchUserInstallations(token)]);
    const session = await signSession({ login: user.login, userId: user.id, installationIds });
    await getStore().appendAudit({ actor: user.login, action: "auth.login", details: { installations: installationIds.length } });
    const res = NextResponse.redirect(`${base}${safeReturnTo(decodeURIComponent(returnToEncoded ?? ""))}`);
    res.cookies.set(SESSION_COOKIE, session, sessionCookieOptions());
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  } catch (err) {
    console.error("Auth callback failed:", err instanceof Error ? err.message : err);
    return fail("oauth_failed");
  }
}
