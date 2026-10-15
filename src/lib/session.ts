import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { getEnv } from "@/config/env";

export const SESSION_COOKIE = "guardian_session";
export const OAUTH_STATE_COOKIE = "guardian_oauth_state";
const SESSION_TTL_SECONDS = 4 * 60 * 60;

export interface Session {
  login: string;
  userId: number;
  /** GitHub App installations this user can access, captured at sign-in. The OAuth token itself is never stored. */
  installationIds: number[];
}

const key = () => new TextEncoder().encode(getEnv().SESSION_SECRET);

export async function signSession(s: Session): Promise<string> {
  return new SignJWT({ login: s.login, uid: s.userId, inst: s.installationIds })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .setIssuer("github-merge-guardian")
    .sign(key());
}

export async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: "github-merge-guardian", algorithms: ["HS256"] });
    if (typeof payload.login !== "string" || typeof payload.uid !== "number" || !Array.isArray(payload.inst)) return null;
    return { login: payload.login, userId: payload.uid, installationIds: payload.inst.filter((n): n is number => typeof n === "number") };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

export const sessionCookieOptions = (maxAge = SESSION_TTL_SECONDS) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});

export function isAdmin(s: Session): boolean {
  return getEnv()
    .GUARDIAN_ADMIN_LOGINS.split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .includes(s.login.toLowerCase());
}

/** Only same-site relative paths are valid post-login destinations (prevents open redirects). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/dashboard";
  return value;
}
