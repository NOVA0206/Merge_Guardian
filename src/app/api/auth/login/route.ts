import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { appBaseUrl } from "@/lib/app-url";
import { authorizeUrl } from "@/lib/github-oauth";
import { OAUTH_STATE_COOKIE, safeReturnTo } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    getEnv();
  } catch (err) {
    console.error("Auth login failed - missing configuration:", err instanceof Error ? err.message : err);
    return NextResponse.redirect(new URL("/?error=configuration", req.url));
  }
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const state = randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(authorizeUrl(state, `${appBaseUrl(req)}/api/auth/callback`));
  // state + returnTo travel in an httpOnly cookie; the state param must match on callback (CSRF protection).
  res.cookies.set(OAUTH_STATE_COOKIE, `${state}.${encodeURIComponent(returnTo)}`, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
