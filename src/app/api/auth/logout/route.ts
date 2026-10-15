import { NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/app-url";
import { SESSION_COOKIE } from "@/lib/session";
import { isSameOrigin } from "@/lib/access";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  const res = NextResponse.redirect(`${appBaseUrl(req)}/`, { status: 303 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
